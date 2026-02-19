/**
 * Whiteboard Project (.wbproj) 型定義
 * 
 * project.toml の構造を定義
 */

// ========================================
// 背景パターン
// ========================================

export type BackgroundPattern = 'none' | 'dots' | 'grid' | 'lines';

// ========================================
// project.toml 構造
// ========================================

/** [project] セクション */
export interface ProjectInfo {
  version: string;
  name: string;
  createdAt: string;    // ISO 8601
  updatedAt: string;    // ISO 8601
}

/** [background] セクション */
export interface BackgroundConfig {
  color: string;              // hex
  pattern: BackgroundPattern;
  patternSize: number;        // px
  patternColor: string;       // hex
}

/** [rendering] セクション */
export interface RenderingConfig {
  boardOverlayMargin: number;
  boardOverlayFallbackViewport: { x: number; y: number; width: number; height: number };
}

/** [collaboration] セクション */
export interface CollaborationConfig {
  signalingServer?: string;   // wss:// URL
}

/** [boards.{id}] セクション */
export interface BoardInfo {
  id: string;                 // ファイル名（0001, 0002, ...）
  name: string;
  displayOrder: number;
  createdAt: string;          // ISO 8601
  updatedAt: string;          // ISO 8601
  hostedBy: string;           // session_id（空文字 = 未ホスト）
  hostedSince: string;        // ISO 8601（空文字 = 未ホスト）
  canvasWidth?: number;       // px（省略 = 無限キャンバス）
  canvasHeight?: number;      // px（省略 = 無限キャンバス）
}

/** [assets.{uuid}] セクション（外部アセットのみ） */
export interface ImportedAssetInfo {
  uuid: string;
  originalPath: string;
  importedBy: string;         // session_id
  importedAt: string;         // ISO 8601
  mimeType: string;
  fileSize: number;           // bytes
}

/** project.toml 全体 */
export interface ProjectConfig {
  project: ProjectInfo;
  background: BackgroundConfig;
  rendering: RenderingConfig;
  collaboration: CollaborationConfig;
  boards: Map<string, BoardInfo>;
  assets: Map<string, ImportedAssetInfo>;
}

// ========================================
// デフォルト値
// ========================================

export const DEFAULT_BACKGROUND: BackgroundConfig = {
  color: '#ffffff',
  pattern: 'none',
  patternSize: 20,
  patternColor: '#e0e0e0',
};

export const DEFAULT_RENDERING: RenderingConfig = {
  boardOverlayMargin: 50,
  boardOverlayFallbackViewport: { x: -960, y: -540, width: 1920, height: 1080 },
};

export const DEFAULT_COLLABORATION: CollaborationConfig = {
  signalingServer: undefined,
};

// ========================================
// ファクトリ関数
// ========================================

/** 新規プロジェクト設定を作成 */
export function createProjectConfig(name: string): ProjectConfig {
  const now = new Date().toISOString();
  return {
    project: {
      version: '2.0',
      name,
      createdAt: now,
      updatedAt: now,
    },
    background: { ...DEFAULT_BACKGROUND },
    rendering: { ...DEFAULT_RENDERING, boardOverlayFallbackViewport: { ...DEFAULT_RENDERING.boardOverlayFallbackViewport } },
    collaboration: { ...DEFAULT_COLLABORATION },
    boards: new Map(),
    assets: new Map(),
  };
}

/** 新規ボード情報を作成 */
export function createBoardInfo(id: string, name: string, displayOrder: number): BoardInfo {
  const now = new Date().toISOString();
  return {
    id,
    name,
    displayOrder,
    createdAt: now,
    updatedAt: now,
    hostedBy: '',
    hostedSince: '',
  };
}

// ========================================
// TOML シリアライズ
// ========================================

/** ProjectConfig を TOML 文字列に変換 */
export function projectConfigToToml(config: ProjectConfig): string {
  const lines: string[] = [];

  // [project]
  lines.push('[project]');
  lines.push(`version = "${config.project.version}"`);
  lines.push(`name = "${config.project.name}"`);
  lines.push(`created_at = "${config.project.createdAt}"`);
  lines.push(`updated_at = "${config.project.updatedAt}"`);
  lines.push('');

  // [background]
  lines.push('[background]');
  lines.push(`color = "${config.background.color}"`);
  lines.push(`pattern = "${config.background.pattern}"`);
  lines.push(`pattern_size = ${config.background.patternSize}`);
  lines.push(`pattern_color = "${config.background.patternColor}"`);
  lines.push('');

  // [rendering]
  lines.push('[rendering]');
  lines.push(`board_overlay_margin = ${config.rendering.boardOverlayMargin}`);
  const fv = config.rendering.boardOverlayFallbackViewport;
  lines.push(`board_overlay_fallback_viewport = { x = ${fv.x}, y = ${fv.y}, width = ${fv.width}, height = ${fv.height} }`);
  lines.push('');

  // [collaboration]
  if (config.collaboration.signalingServer) {
    lines.push('[collaboration]');
    lines.push(`signaling_server = "${config.collaboration.signalingServer}"`);
    lines.push('');
  }

  // [boards.{id}]
  for (const [id, board] of config.boards) {
    lines.push(`[boards.${id}]`);
    lines.push(`name = "${board.name}"`);
    lines.push(`display_order = ${board.displayOrder}`);
    lines.push(`created_at = "${board.createdAt}"`);
    lines.push(`updated_at = "${board.updatedAt}"`);
    if (board.hostedBy) {
      lines.push(`hosted_by = "${board.hostedBy}"`);
      lines.push(`hosted_since = "${board.hostedSince}"`);
    }
    if (board.canvasWidth && board.canvasHeight) {
      lines.push(`canvas_width = ${board.canvasWidth}`);
      lines.push(`canvas_height = ${board.canvasHeight}`);
    }
    lines.push('');
  }

  // [assets.{uuid}]
  for (const [uuid, asset] of config.assets) {
    lines.push(`[assets."${uuid}"]`);
    lines.push(`original_path = "${asset.originalPath}"`);
    lines.push(`imported_by = "${asset.importedBy}"`);
    lines.push(`imported_at = "${asset.importedAt}"`);
    lines.push(`mime_type = "${asset.mimeType}"`);
    lines.push(`file_size = ${asset.fileSize}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ========================================
// ソート
// ========================================

export type BoardSortKey = 'displayOrder' | 'createdAt' | 'updatedAt' | 'name';

/** ボードをソート */
export function sortBoards(boards: BoardInfo[], sortKey: BoardSortKey, ascending = true): BoardInfo[] {
  const sorted = [...boards].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'displayOrder':
        cmp = a.displayOrder - b.displayOrder;
        break;
      case 'createdAt':
        cmp = a.createdAt.localeCompare(b.createdAt);
        break;
      case 'updatedAt':
        cmp = a.updatedAt.localeCompare(b.updatedAt);
        break;
      case 'name':
        cmp = a.name.localeCompare(b.name);
        break;
    }
    return ascending ? cmp : -cmp;
  });
  return sorted;
}
