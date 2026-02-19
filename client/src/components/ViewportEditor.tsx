/**
 * ViewportEditor - オーバーレイの表示領域設定モーダル
 *
 * 画像 / PDF / ボードの Viewport を編集するための共通フレーム。
 * canvasSize の計算は各サブコンポーネントに委譲し、
 * このコンポーネントはアセット選択・フッター・アスペクト比リセットのみを担う。
 */

import { useState, useCallback, useRef } from 'react';
import type { OverlayState, AssetType } from '../types';
import { ViewportEditorImage } from './ViewportEditorImage';
import { ViewportEditorPdf } from './ViewportEditorPdf';
import { ViewportEditorBoard, DEFAULT_BOARD_VIEWPORT } from './ViewportEditorBoard';

// ----------------------------------------------------------------
// 型
// ----------------------------------------------------------------

type Viewport = { x: number; y: number; width: number; height: number };

export interface ViewportEditorProps {
  overlay: OverlayState;
  assetType: AssetType;
  assetUuid: string;
  assetName: string;
  availableAssets: Array<{ uuid: string; fileName: string; type: AssetType }>;
  /** ホワイトボードリサイズ時に AR を固定するか（デフォルト: true） */
  lockAspectRatio: boolean;
  onApply: (
    viewport: Viewport,
    page: number,
    newAssetUuid?: string,
    overlayTransform?: { x: number; y: number; width: number; height: number },
    naturalSize?: { width: number; height: number },
    lockAspectRatio?: boolean,
    /** board type のとき、ViewportEditor が最初にユーザーに見せた実効初期 viewport */
    initialBoardViewport?: Viewport,
  ) => void;
  onClose: () => void;
  onUploadFile?: (file: File) => Promise<string | null>;
}

// ----------------------------------------------------------------
// コンポーネント
// ----------------------------------------------------------------

export function ViewportEditor({
  overlay,
  assetType,
  assetUuid,
  assetName,
  availableAssets,
  lockAspectRatio: lockAspectRatioProp,
  onApply,
  onClose,
  onUploadFile,
}: ViewportEditorProps) {
  // --- アセット選択 ---
  const [currentAssetUuid, setCurrentAssetUuid] = useState(assetUuid);
  const [showDropdown, setShowDropdown] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Viewport / ページ ---
  const [viewport, setViewport] = useState<Viewport>(overlay.viewport);
  const [page, setPage] = useState(overlay.page || 1);

  // --- アスペクト比ロック ---
  const [lockAspectRatioLocal, setLockAspectRatioLocal] = useState(lockAspectRatioProp);

  // --- アスペクト比リセット ---
  // サブコンポーネントから通知されたアセットのアスペクト比

  // 画像/PDFの自然サイズ（px）: trim 後の overlay 位置計算用
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  // board type の実効初期 viewport（applyInitialFit が決定した値、vpOld として handleApplyViewport で使用）
  const [initialBoardViewport, setInitialBoardViewport] = useState<Viewport | null>(null);
  // アスペクト比リセット時に変更するオーバーレイのトランスフォーム
  const [overlayTransform, setOverlayTransform] = useState<
    { x: number; y: number; width: number; height: number } | null
  >(null);

  // ----------------------------------------------------------------
  // アセット変更
  // ----------------------------------------------------------------

  const handleAssetChange = useCallback((uuid: string) => {
    setCurrentAssetUuid(uuid);
    setShowDropdown(false);

    setOverlayTransform(null);

    // viewport をリセット
    if (assetType === 'board') {
      setViewport(DEFAULT_BOARD_VIEWPORT);
    } else {
      setViewport({ x: 0, y: 0, width: 0, height: 0 });
    }
    setPage(1);
  }, [assetType]);

  // ----------------------------------------------------------------
  // ファイルアップロード
  // ----------------------------------------------------------------

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onUploadFile) return;

    setIsUploading(true);
    try {
      const newUuid = await onUploadFile(file);
      if (newUuid) {
        setCurrentAssetUuid(newUuid);
        setViewport({ x: 0, y: 0, width: 0, height: 0 });
        setPage(1);
    
        setOverlayTransform(null);
      }
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [onUploadFile]);

  // ----------------------------------------------------------------
  // 適用
  // ----------------------------------------------------------------

  const handleApply = useCallback(() => {
    const newAssetUuid = currentAssetUuid !== assetUuid ? currentAssetUuid : undefined;

    // board 以外は「仮想的な全体表示」を保持する overlay transform を計算
    let finalTransform: { x: number; y: number; width: number; height: number } | undefined;

    if (assetType !== 'board' && naturalSize) {
      const { width: iw, height: ih } = naturalSize;

      // AR 変更後の中間状態（AR リセット未実施なら元の overlay サイズを使う）
      const mid = overlayTransform ?? {
        x: overlay.x, y: overlay.y,
        width: overlay.width, height: overlay.height,
      };

      // 元の viewport（編集前）を正規化
      const ovp = overlay.viewport;
      const evpOld = (ovp.width > 0 && ovp.height > 0)
        ? ovp
        : { x: 0, y: 0, width: iw, height: ih };

      // スケール: WB 単位 / ソース px（仮想全体表示のスケール）
      const sx = mid.width  / evpOld.width;
      const sy = mid.height / evpOld.height;

      // 仮想全体表示の WB 上の起点
      const tx = mid.x - evpOld.x * sx;
      const ty = mid.y - evpOld.y * sy;

      // 新しい viewport を正規化
      const nvp = viewport;
      const evpNew = (nvp.width > 0 && nvp.height > 0)
        ? nvp
        : { x: 0, y: 0, width: iw, height: ih };

      const finalX = tx + evpNew.x * sx;
      const finalY = ty + evpNew.y * sy;
      const finalW = evpNew.width  * sx;
      const finalH = evpNew.height * sy;

      // 元の状態から変化があるときだけ overlayTransform を設定
      const unchanged =
        Math.abs(finalX - overlay.x) < 0.5 &&
        Math.abs(finalY - overlay.y) < 0.5 &&
        Math.abs(finalW - overlay.width) < 0.5 &&
        Math.abs(finalH - overlay.height) < 0.5;

      if (!unchanged) {
        finalTransform = {
          x: Math.round(finalX),
          y: Math.round(finalY),
          width:  Math.max(1, Math.round(finalW)),
          height: Math.max(1, Math.round(finalH)),
        };
      }
    } else {
      // board: overlayTransform はそのまま（AR リセットで設定された値）
      finalTransform = overlayTransform ?? undefined;
    }

    onApply(viewport, page, newAssetUuid, finalTransform, naturalSize ?? undefined, lockAspectRatioLocal, initialBoardViewport ?? undefined);
  }, [viewport, page, currentAssetUuid, assetUuid, onApply, overlayTransform, overlay, assetType, naturalSize, lockAspectRatioLocal, initialBoardViewport]);

  // ----------------------------------------------------------------
  // 表示用データ
  // ----------------------------------------------------------------

  const sameTypeAssets = availableAssets.filter((a) => a.type === assetType);
  const currentAssetName = sameTypeAssets.find((a) => a.uuid === currentAssetUuid)?.fileName ?? assetName;
  const acceptTypes = assetType === 'image' ? 'image/*' : assetType === 'document' ? 'application/pdf' : '';

  const titles: Record<AssetType, string> = {
    image: '画像の表示設定',
    document: 'PDF の表示設定',
    board: 'ボードの表示設定',
  };

  // ----------------------------------------------------------------
  // レンダリング
  // ----------------------------------------------------------------

  return (
    <div className="viewport-editor-backdrop" onClick={onClose}>
      <div
        className="viewport-editor-modal"
        onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="viewport-editor-header">
          <h2 className="viewport-editor-title">{titles[assetType]}</h2>
          <button className="viewport-editor-close" onClick={onClose}>✕</button>
        </div>

        {/* アセット選択 */}
        <div className="viewport-editor-asset-selector">
          <span className="viewport-editor-label">アセット:</span>

          <div className="viewport-editor-asset-dropdown-container">
            <button
              className="viewport-editor-asset-button"
              onClick={() => setShowDropdown((v: boolean) => !v)}
            >
              {currentAssetName}
              <span className="dropdown-arrow">▼</span>
            </button>

            {showDropdown && (
              <>
                <div className="dropdown-backdrop" onClick={() => setShowDropdown(false)} />
                <div className="viewport-editor-asset-dropdown">
                  {sameTypeAssets.length === 0 ? (
                    <div className="dropdown-item disabled">利用可能なアセットがありません</div>
                  ) : (
                    sameTypeAssets.map((a) => (
                      <button
                        key={a.uuid}
                        className={`dropdown-item ${a.uuid === currentAssetUuid ? 'selected' : ''}`}
                        onClick={() => handleAssetChange(a.uuid)}
                      >
                        {a.fileName}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          {onUploadFile && assetType !== 'board' && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept={acceptTypes}
                style={{ display: 'none' }}
                onChange={handleFileChange}
              />
              <button
                className="viewport-editor-upload-btn"
                onClick={handleUploadClick}
                disabled={isUploading}
              >
                {isUploading ? 'アップロード中...' : 'アップロード...'}
              </button>
            </>
          )}
        </div>

        {/* コンテンツ（サブコンポーネントが position: absolute で親を埋める） */}
        <div className="viewport-editor-content">
          {assetType === 'image' && (
            <ViewportEditorImage
              assetUuid={currentAssetUuid}
              viewport={viewport}
              onViewportChange={setViewport}

              onNaturalSizeDetected={(w, h) => setNaturalSize({ width: w, height: h })}
            />
          )}
          {assetType === 'document' && (
            <ViewportEditorPdf
              assetUuid={currentAssetUuid}
              viewport={viewport}
              page={page}
              onViewportChange={setViewport}
              onPageChange={setPage}

              onNaturalSizeDetected={(w, h) => setNaturalSize({ width: w, height: h })}
            />
          )}
          {assetType === 'board' && (
            <ViewportEditorBoard
              assetUuid={currentAssetUuid}
              viewport={viewport}
              onViewportChange={setViewport}
              onInitialViewportReady={setInitialBoardViewport}
            />
          )}
        </div>

        {/* フッター */}
        <div className="viewport-editor-footer">
          {/* AR ロックチェックボックス（board 以外で表示） */}
          {assetType !== 'board' && (
            <label className="viewport-editor-lock-ar">
              <input
                type="checkbox"
                checked={lockAspectRatioLocal}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLockAspectRatioLocal(e.target.checked)}
              />
              アスペクト比を固定する
            </label>
          )}
          <div style={{ flex: 1 }} />
          <button className="viewport-editor-cancel-btn" onClick={onClose}>キャンセル</button>
          <button className="viewport-editor-apply-btn" onClick={handleApply}>適用</button>
        </div>
      </div>
    </div>
  );
}
