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
  onApply: (
    viewport: Viewport,
    page: number,
    newAssetUuid?: string,
    overlayTransform?: { x: number; y: number; width: number; height: number }
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

  // --- アスペクト比リセット ---
  // サブコンポーネントから通知されたアセットのアスペクト比
  const [assetAspectRatio, setAssetAspectRatio] = useState<number | null>(null);
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
    setAssetAspectRatio(null);
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
        setAssetAspectRatio(null);
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
  // アスペクト比リセット（等積変形・重心維持）
  // ----------------------------------------------------------------

  const handleResetAspectRatio = useCallback(() => {
    if (assetAspectRatio === null) return;

    const cur = overlayTransform || {
      x: overlay.x, y: overlay.y,
      width: overlay.width, height: overlay.height,
    };
    const area = cur.width * cur.height;
    const cx = cur.x + cur.width / 2;
    const cy = cur.y + cur.height / 2;

    const nw = Math.sqrt(area * assetAspectRatio);
    const nh = Math.sqrt(area / assetAspectRatio);

    setOverlayTransform({
      x: Math.round(cx - nw / 2),
      y: Math.round(cy - nh / 2),
      width: Math.round(nw),
      height: Math.round(nh),
    });
  }, [assetAspectRatio, overlay, overlayTransform]);

  // ----------------------------------------------------------------
  // 適用
  // ----------------------------------------------------------------

  const handleApply = useCallback(() => {
    const newAssetUuid = currentAssetUuid !== assetUuid ? currentAssetUuid : undefined;
    onApply(viewport, page, newAssetUuid, overlayTransform || undefined);
  }, [viewport, page, currentAssetUuid, assetUuid, onApply, overlayTransform]);

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
        onClick={(e) => e.stopPropagation()}
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
              onClick={() => setShowDropdown((v) => !v)}
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
              onAspectRatioDetected={setAssetAspectRatio}
            />
          )}
          {assetType === 'document' && (
            <ViewportEditorPdf
              assetUuid={currentAssetUuid}
              viewport={viewport}
              page={page}
              onViewportChange={setViewport}
              onPageChange={setPage}
              onAspectRatioDetected={setAssetAspectRatio}
            />
          )}
          {assetType === 'board' && (
            <ViewportEditorBoard
              assetUuid={currentAssetUuid}
              viewport={viewport}
              onViewportChange={setViewport}
            />
          )}
        </div>

        {/* フッター */}
        <div className="viewport-editor-footer">
          {assetType !== 'board' && assetAspectRatio !== null && (
            <button
              className="viewport-editor-reset-aspect-btn"
              onClick={handleResetAspectRatio}
              title="オーバーレイのサイズをアセットのアスペクト比に合わせます（面積を維持）"
            >
              📐 アスペクト比をリセット
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="viewport-editor-cancel-btn" onClick={onClose}>キャンセル</button>
          <button className="viewport-editor-apply-btn" onClick={handleApply}>適用</button>
        </div>
      </div>
    </div>
  );
}