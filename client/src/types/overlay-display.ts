/**
 * OverlayDisplayState — オーバーレイの表示状態を統一的に管理する型
 *
 * 状態遷移:
 *   loading → requesting → transferring → ready
 *                                       → error
 *   ready → loading (ページ変更等による再生成)
 */

export type OverlayDisplayStatus = 'loading' | 'requesting' | 'transferring' | 'ready' | 'error';

export type OverlayErrorReason = 'assetNotFound' | 'decodeFailed' | 'peerDisconnected';

export interface OverlayDisplayState {
  status: OverlayDisplayStatus;
  /** ready 時の画像。loading 中も旧画像を保持できる */
  image: HTMLImageElement | null;
  /** transferring 時の進捗 (0.0 - 1.0) */
  progress?: number;
  /** error 時の理由 */
  errorReason?: OverlayErrorReason;
}

// ========================================
// ファクトリ関数
// ========================================

export function createLoadingState(prevImage?: HTMLImageElement | null): OverlayDisplayState {
  return { status: 'loading', image: prevImage ?? null };
}

export function createRequestingState(): OverlayDisplayState {
  return { status: 'requesting', image: null };
}

export function createTransferringState(progress: number): OverlayDisplayState {
  return { status: 'transferring', image: null, progress };
}

export function createReadyState(image: HTMLImageElement): OverlayDisplayState {
  return { status: 'ready', image };
}

export function createErrorState(reason: OverlayErrorReason): OverlayDisplayState {
  return { status: 'error', image: null, errorReason: reason };
}
