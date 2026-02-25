/**
 * useOverlayDisplay — オーバーレイ画像読み込み・表示状態管理 (Phase 2c)
 *
 * 所有する状態:
 *   overlayDisplayStates, overlayRenderKeyRef, overlayOpacityOverrides,
 *   overlayLockAspectRatios, pdfPageCounts, overlayImages (derived)
 *
 * 3 つの useEffect を内包:
 *   1. メイン画像読み込み（renderKey ベースの差分再生成）
 *   2. P2P 転送進捗の反映
 *   3. PDF ページ数取得
 */
import { useState, useRef, useMemo, useEffect, type MutableRefObject } from 'react';
import type {
  WbelxEvent,
  OverlayState,
  AssetType,
  AssetIndex,
  CanvasTransform,
  BackgroundConfig,
} from '../types';
import type { OverlayDisplayState } from '../types/overlay-display';
import {
  createRequestingState,
  createReadyState,
  createErrorState,
  createTransferringState,
} from '../types/overlay-display';
import { loadAssetFileAsDataUrl } from '../utils/storage';
import { loadPdfDocument, renderPdfPage, getPdfPageCount } from '../utils/pdf';
import { computeState, getActiveStrokes, getActiveOverlays } from '../core/state-machine';
import { loadBoardSnapshot } from '../utils/storage';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BoardInfo {
  id: string;
  name: string;
}

interface UseOverlayDisplayProps {
  activeOverlays: OverlayState[];
  canvasTransform: CanvasTransform;
  resolvedAssetIndex: AssetIndex | null;
  background: BackgroundConfig | undefined;
  assetReceivedVersion: number;
  assetTransferProgress: Map<string, { progress: number }>;
  requestAssetP2p: (uuid: string) => void;
  getBoards: () => BoardInfo[];
  getBoardUuid: (boardId: string) => string | undefined;
  loadBoardEventsAsync: (boardId: string) => Promise<WbelxEvent[]>;
}

interface UseOverlayDisplayReturn {
  // State
  overlayDisplayStates: Map<string, OverlayDisplayState>;
  setOverlayDisplayStates: React.Dispatch<React.SetStateAction<Map<string, OverlayDisplayState>>>;
  overlayRenderKeyRef: MutableRefObject<Map<string, string>>;
  overlayOpacityOverrides: Map<string, number>;
  setOverlayOpacityOverrides: React.Dispatch<React.SetStateAction<Map<string, number>>>;
  overlayLockAspectRatios: Map<string, boolean>;
  setOverlayLockAspectRatios: React.Dispatch<React.SetStateAction<Map<string, boolean>>>;
  // Derived
  overlayImages: Map<string, HTMLImageElement>;
  pdfPageCounts: Map<string, number>;
  overlayAssetTypes: Map<string, AssetType>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useOverlayDisplay({
  activeOverlays,
  canvasTransform,
  resolvedAssetIndex,
  background,
  assetReceivedVersion,
  assetTransferProgress,
  requestAssetP2p,
  getBoards,
  getBoardUuid,
  loadBoardEventsAsync,
}: UseOverlayDisplayProps): UseOverlayDisplayReturn {
  // ========================================
  // State
  // ========================================
  const [overlayDisplayStates, setOverlayDisplayStates] = useState<Map<string, OverlayDisplayState>>(new Map());
  const overlayRenderKeyRef = useRef<Map<string, string>>(new Map());
  const [overlayOpacityOverrides, setOverlayOpacityOverrides] = useState<Map<string, number>>(new Map());
  const [overlayLockAspectRatios, setOverlayLockAspectRatios] = useState<Map<string, boolean>>(new Map());
  const [pdfPageCounts, setPdfPageCounts] = useState<Map<string, number>>(new Map());

  // overlayDisplayStates から画像のみ抽出（エクスポート用）
  const overlayImages = useMemo(() => {
    const map = new Map<string, HTMLImageElement>();
    for (const [id, ds] of overlayDisplayStates) {
      if (ds.image) map.set(id, ds.image);
    }
    return map;
  }, [overlayDisplayStates]);

  // ========================================
  // Effect 1: メイン画像読み込み
  // ========================================
  useEffect(() => {
    // ----------------------------------------------------------------
    // ヘルパー: 生画像キャッシュ（assetUuid → HTMLImageElement）
    // ----------------------------------------------------------------
    const rawImageCache = new Map<string, HTMLImageElement>();
    const pdfPageCache = new Map<string, HTMLImageElement>(); // key: assetUuid:page

    const loadRawImage = async (assetUuid: string): Promise<HTMLImageElement | null> => {
      if (rawImageCache.has(assetUuid)) return rawImageCache.get(assetUuid)!;
      const dataUrl = await loadAssetFileAsDataUrl(assetUuid);
      if (!dataUrl) return null;
      const img = new Image();
      img.src = dataUrl;
      await new Promise<void>(r => { img.onload = () => r(); img.onerror = () => r(); });
      rawImageCache.set(assetUuid, img);
      return img;
    };

    const loadPdfPage = async (assetUuid: string, page: number): Promise<HTMLImageElement | null> => {
      const key = `${assetUuid}:${page}`;
      if (pdfPageCache.has(key)) return pdfPageCache.get(key)!;
      const dataUrl = await loadAssetFileAsDataUrl(assetUuid);
      if (!dataUrl) return null;
      try {
        const pdfDoc = await loadPdfDocument(dataUrl);
        const img = await renderPdfPage(pdfDoc, page > 0 ? page : 1);
        pdfPageCache.set(key, img);
        return img;
      } catch { return null; }
    };

    // ----------------------------------------------------------------
    // ヘルパー: ボードをオフスクリーン canvas にレンダリング（再帰対応）
    // ----------------------------------------------------------------
    const renderBoardToImage = async (
      boardOverlayState: { assetUuid: string; viewport: { x: number; y: number; width: number; height: number }; width: number; height: number; displayScale: number },
      depth: number
    ): Promise<HTMLImageElement | null> => {
      if (depth > 6) return null;

      const boards = getBoards();
      let targetBoardId: string | null = null;
      for (const board of boards) {
        if (getBoardUuid(board.id) === boardOverlayState.assetUuid) {
          targetBoardId = board.id;
          break;
        }
      }
      if (!targetBoardId) return null;

      let events: WbelxEvent[];
      try {
        const snapshotEvents = await loadBoardSnapshot(targetBoardId);
        events = snapshotEvents?.length ? snapshotEvents : await loadBoardEventsAsync(targetBoardId);
      } catch { return null; }

      const boardState = computeState(events);
      const boardStrokes = getActiveStrokes(boardState);
      const boardSubOverlays = getActiveOverlays(boardState);

      // 描画範囲の決定
      const vp = boardOverlayState.viewport;
      const hasVp = vp.width > 0 && vp.height > 0;
      let minX: number, minY: number, maxX: number, maxY: number;

      if (hasVp) {
        minX = vp.x; minY = vp.y;
        maxX = vp.x + vp.width; maxY = vp.y + vp.height;
      } else {
        minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
        for (const s of boardStrokes) {
          if (s.bbox) {
            minX = Math.min(minX, s.bbox[0]); minY = Math.min(minY, s.bbox[1]);
            maxX = Math.max(maxX, s.bbox[2]); maxY = Math.max(maxY, s.bbox[3]);
          }
        }
        for (const o of boardSubOverlays) {
          minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
          maxX = Math.max(maxX, o.x + o.width); maxY = Math.max(maxY, o.y + o.height);
        }
        if (minX === Infinity) { minX = -960; minY = -540; maxX = 960; maxY = 540; }
      }

      const contentW = Math.max(maxX - minX, 1);
      const contentH = Math.max(maxY - minY, 1);

      // サムネイルサイズ
      const aspect = contentW / contentH;
      const displayW = boardOverlayState.width * boardOverlayState.displayScale;
      const thumbW = Math.min(Math.ceil(displayW * (window.devicePixelRatio || 1) * 1.5), 4096);
      const thumbH = Math.round(thumbW / aspect);
      const scale = thumbW / contentW;

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = thumbW;
      thumbCanvas.height = thumbH;
      const ctx = thumbCanvas.getContext('2d')!;

      // 背景
      const bg = background;
      ctx.fillStyle = bg?.color || '#ffffff';
      ctx.fillRect(0, 0, thumbW, thumbH);

      // 背景パターン
      const bgPattern = bg?.pattern || 'none';
      if (bgPattern !== 'none') {
        ctx.save();
        ctx.scale(scale, scale);
        ctx.translate(-minX, -minY);
        const gridSize = bg?.patternSize || 20;
        ctx.strokeStyle = bg?.patternColor || '#e0e0e0';
        ctx.fillStyle = bg?.patternColor || '#e0e0e0';
        ctx.lineWidth = 1 / scale;
        const gx0 = Math.floor(minX / gridSize) * gridSize;
        const gy0 = Math.floor(minY / gridSize) * gridSize;
        if (bgPattern === 'grid' || bgPattern === 'lines') {
          ctx.beginPath();
          for (let y = gy0; y <= maxY; y += gridSize) { ctx.moveTo(minX, y); ctx.lineTo(maxX, y); }
          if (bgPattern === 'grid') {
            for (let x = gx0; x <= maxX; x += gridSize) { ctx.moveTo(x, minY); ctx.lineTo(x, maxY); }
          }
          ctx.stroke();
        }
        if (bgPattern === 'dots') {
          const radius = Math.max(1 / scale, 0.8);
          for (let x = gx0; x <= maxX; x += gridSize) {
            for (let y = gy0; y <= maxY; y += gridSize) {
              ctx.beginPath();
              ctx.arc(x, y, radius, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        ctx.restore();
      }

      // サブオーバーレイ
      const subAssetTypeMap = new Map<string, AssetType>();
      for (const subOv of boardSubOverlays) {
        const subAsset = resolvedAssetIndex?.byUuid.get(subOv.assetUuid);
        subAssetTypeMap.set(subOv.overlayId, subAsset?.type ?? 'image');
      }

      const subImgMap = new Map<string, HTMLImageElement>();
      await Promise.all(boardSubOverlays.map(async (subOv) => {
        const subAsset = resolvedAssetIndex?.byUuid.get(subOv.assetUuid);
        if (!subAsset) return;
        let subImg: HTMLImageElement | null = null;
        try {
          if (subAsset.type === 'image') {
            subImg = await loadRawImage(subOv.assetUuid);
          } else if (subAsset.type === 'document') {
            subImg = await loadPdfPage(subOv.assetUuid, subOv.page > 0 ? subOv.page : 1);
          } else if (subAsset.type === 'board') {
            subImg = await renderBoardToImage(
              { assetUuid: subOv.assetUuid, viewport: subOv.viewport, width: subOv.width, height: subOv.height, displayScale: boardOverlayState.displayScale },
              depth + 1
            );
          }
        } catch { /* skip */ }
        if (subImg) subImgMap.set(subOv.overlayId, subImg);
      }));

      // オーバーレイ描画
      ctx.save();
      ctx.scale(scale, scale);
      ctx.translate(-minX, -minY);
      for (const subOv of boardSubOverlays) {
        const subImg = subImgMap.get(subOv.overlayId);
        const subAssetType = subAssetTypeMap.get(subOv.overlayId) ?? 'image';
        ctx.save();
        ctx.globalAlpha = subOv.opacity;
        if (subImg && subImg.complete) {
          if (subAssetType !== 'board' && subOv.viewport.width > 0 && subOv.viewport.height > 0) {
            ctx.drawImage(
              subImg,
              subOv.viewport.x, subOv.viewport.y, subOv.viewport.width, subOv.viewport.height,
              subOv.x, subOv.y, subOv.width, subOv.height
            );
          } else {
            ctx.drawImage(subImg, subOv.x, subOv.y, subOv.width, subOv.height);
          }
        } else {
          ctx.fillStyle = '#d1d5db';
          ctx.fillRect(subOv.x, subOv.y, subOv.width, subOv.height);
        }
        ctx.restore();
      }
      ctx.restore();

      // ストローク描画
      ctx.save();
      ctx.scale(scale, scale);
      ctx.translate(-minX, -minY);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const stroke of boardStrokes) {
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.stroke(new Path2D(stroke.path));
      }
      ctx.restore();

      // HTMLImageElement に変換
      const resultImg = new Image();
      resultImg.src = thumbCanvas.toDataURL('image/png');
      await new Promise<void>(r => { resultImg.onload = () => r(); });
      return resultImg;
    };

    // ----------------------------------------------------------------
    // メイン: 各 overlay のレンダリングキーを確認し、必要なものを再生成
    // ----------------------------------------------------------------
    const loadImages = async () => {
      const newStates = new Map<string, OverlayDisplayState>();
      const missingUuids: string[] = [];

      for (const overlay of activeOverlays) {
        const asset = resolvedAssetIndex?.byUuid.get(overlay.assetUuid);
        const assetType = asset?.type ?? 'image';

        const displayPixels = overlay.width * canvasTransform.scale;
        const zoomTier = assetType === 'board' ? Math.ceil(Math.log2(Math.max(displayPixels, 1))) : 0;
        const vpKey = `${overlay.viewport.x},${overlay.viewport.y},${overlay.viewport.width},${overlay.viewport.height}`;
        const renderKey = assetType === 'board'
          ? `board:${overlay.assetUuid}:${vpKey}:z${zoomTier}`
          : assetType === 'document'
          ? `pdf:${overlay.assetUuid}:${overlay.page || 1}`
          : `img:${overlay.assetUuid}`;

        const prevKey = overlayRenderKeyRef.current.get(overlay.overlayId);
        const prevState = overlayDisplayStates.get(overlay.overlayId);

        if (prevKey === renderKey && prevState?.status === 'ready' && prevState.image) {
          newStates.set(overlay.overlayId, prevState);
          continue;
        }

        // --- 再生成が必要 ---
        let img: HTMLImageElement | null = null;

        if (assetType === 'board') {
          img = await renderBoardToImage(
            { assetUuid: overlay.assetUuid, viewport: overlay.viewport, width: overlay.width, height: overlay.height, displayScale: canvasTransform.scale },
            0
          );
          if (!img) {
            newStates.set(overlay.overlayId, createErrorState('assetNotFound'));
          }

        } else if (assetType === 'document') {
          const dataUrl = await loadAssetFileAsDataUrl(overlay.assetUuid);
          if (dataUrl) {
            try {
              const pdfDoc = await loadPdfDocument(dataUrl);
              img = await renderPdfPage(pdfDoc, overlay.page > 0 ? overlay.page : 1);
              pdfPageCache.set(`${overlay.assetUuid}:${overlay.page || 1}`, img);
            } catch {
              newStates.set(overlay.overlayId, createErrorState('decodeFailed'));
            }
          } else {
            missingUuids.push(overlay.assetUuid);
            newStates.set(overlay.overlayId, createRequestingState());
          }

        } else { // image
          img = await loadRawImage(overlay.assetUuid);
          if (!img) {
            missingUuids.push(overlay.assetUuid);
            newStates.set(overlay.overlayId, createRequestingState());
          }
        }

        if (img) {
          newStates.set(overlay.overlayId, createReadyState(img));
          overlayRenderKeyRef.current.set(overlay.overlayId, renderKey);
        }
      }

      // 不足アセットをリクエスト（P2P Data Channel 経由）
      for (const uuid of missingUuids) requestAssetP2p(uuid);

      setOverlayDisplayStates(newStates);
    };

    loadImages();
  // NOTE: 意図的な依存配列制限。内部のヘルパー関数 (loadRawImage, renderBoardToImage) は
  // background, overlayDisplayStates, overlayRenderKeyRef 等をクロージャで参照するが、
  // これらは Ref またはセッターなので再レンダリングトリガーとして不要。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOverlays, assetReceivedVersion, resolvedAssetIndex, canvasTransform]);

  // ========================================
  // Effect 2: P2P 転送進捗を overlayDisplayStates に反映
  // ========================================
  useEffect(() => {
    if (assetTransferProgress.size === 0) return;
    setOverlayDisplayStates((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const overlay of activeOverlays) {
        const prog = assetTransferProgress.get(overlay.assetUuid);
        if (!prog) continue;
        const prevState = prev.get(overlay.overlayId);
        if (!prevState || prevState.status === 'requesting' || prevState.status === 'transferring') {
          next.set(overlay.overlayId, createTransferringState(prog.progress));
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [assetTransferProgress, activeOverlays]);

  // ========================================
  // Effect 3: PDF ページ数取得
  // ========================================
  useEffect(() => {
    const loadPageCounts = async () => {
      const newCounts = new Map<string, number>();

      for (const overlay of activeOverlays) {
        if (pdfPageCounts.has(overlay.assetUuid)) {
          newCounts.set(overlay.assetUuid, pdfPageCounts.get(overlay.assetUuid)!);
          continue;
        }

        const asset = resolvedAssetIndex?.byUuid.get(overlay.assetUuid);
        if (asset?.type !== 'document') continue;

        try {
          const dataUrl = await loadAssetFileAsDataUrl(overlay.assetUuid);
          if (dataUrl) {
            const pdfDoc = await loadPdfDocument(dataUrl);
            newCounts.set(overlay.assetUuid, getPdfPageCount(pdfDoc));
          }
        } catch (error) {
          console.warn('Failed to get PDF page count:', overlay.assetUuid, error);
        }
      }

      if (newCounts.size > 0) {
        setPdfPageCounts((prev: Map<string, number>) => new Map([...prev, ...newCounts]));
      }
    };

    loadPageCounts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOverlays, resolvedAssetIndex]);

  // overlayId → AssetType のマップ（WhiteboardCanvas に渡して描画時に viewport source rect を使うか判定）
  const overlayAssetTypes = useMemo(() => {
    const map = new Map<string, AssetType>();
    for (const overlay of activeOverlays) {
      const asset = resolvedAssetIndex?.byUuid.get(overlay.assetUuid);
      map.set(overlay.overlayId, asset?.type ?? 'image');
    }
    return map;
  }, [activeOverlays, resolvedAssetIndex]);

  return {
    overlayDisplayStates,
    setOverlayDisplayStates,
    overlayRenderKeyRef,
    overlayOpacityOverrides,
    setOverlayOpacityOverrides,
    overlayLockAspectRatios,
    setOverlayLockAspectRatios,
    overlayImages,
    pdfPageCounts,
    overlayAssetTypes,
  };
}