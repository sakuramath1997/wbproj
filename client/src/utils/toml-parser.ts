/**
 * project.toml パーサー
 * 
 * 簡易的な TOML パーサー（本格的には toml ライブラリを使用推奨）
 */

import type {
  ProjectConfig,
  ProjectInfo,
  BackgroundConfig,
  CollaborationConfig,
  BoardInfo,
  ImportedAssetInfo,
  BackgroundPattern,
} from '../types';
import { DEFAULT_BACKGROUND } from '../types';

// ========================================
// TOML パース（簡易実装）
// ========================================

interface TomlSection {
  [key: string]: string | number | boolean | string[];
}

interface TomlDocument {
  [section: string]: TomlSection;
}

/**
 * 簡易 TOML パーサー
 * 
 * 対応する構文:
 * - [section] / [section.subsection]
 * - key = "string" / key = number / key = true/false
 * - key = ["array", "items"]
 */
function parseToml(content: string): TomlDocument {
  const result: TomlDocument = {};
  let currentSection = '';

  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // 空行・コメント
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // セクション
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      continue;
    }

    // キー = 値
    const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (kvMatch && currentSection) {
      const key = kvMatch[1];
      const rawValue = kvMatch[2];
      result[currentSection][key] = parseTomlValue(rawValue);
    }
  }

  return result;
}

function parseTomlValue(raw: string): string | number | boolean | string[] {
  const trimmed = raw.trim();

  // 配列
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1);
    if (!inner.trim()) return [];
    return inner.split(',').map(s => {
      const t = s.trim();
      if (t.startsWith('"') && t.endsWith('"')) {
        return t.slice(1, -1);
      }
      return t;
    });
  }

  // 文字列
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }

  // 真偽値
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // 数値
  const num = Number(trimmed);
  if (!isNaN(num)) return num;

  return trimmed;
}

// ========================================
// ProjectConfig へ変換
// ========================================

/**
 * TOML 文字列から ProjectConfig をパース
 */
export function parseProjectToml(content: string): ProjectConfig {
  const doc = parseToml(content);

  // [project]
  const projectSection = doc['project'] || {};
  const project: ProjectInfo = {
    version: String(projectSection['version'] || '1.0'),
    name: String(projectSection['name'] || 'Untitled'),
    createdAt: String(projectSection['created_at'] || new Date().toISOString()),
    updatedAt: String(projectSection['updated_at'] || new Date().toISOString()),
  };

  // [background]
  const bgSection = doc['background'] || {};
  const background: BackgroundConfig = {
    color: String(bgSection['color'] || DEFAULT_BACKGROUND.color),
    pattern: (String(bgSection['pattern'] || DEFAULT_BACKGROUND.pattern) as BackgroundPattern),
    patternSize: Number(bgSection['pattern_size'] ?? DEFAULT_BACKGROUND.patternSize),
    patternColor: String(bgSection['pattern_color'] || DEFAULT_BACKGROUND.patternColor),
  };

  // [collaboration]
  const collabSection = doc['collaboration'] || {};
  const collaboration: CollaborationConfig = {
    signalingServer: collabSection['signaling_server'] 
      ? String(collabSection['signaling_server']) 
      : undefined,
  };

  // [boards.{id}]
  const boards = new Map<string, BoardInfo>();
  for (const sectionName of Object.keys(doc)) {
    if (sectionName.startsWith('boards.')) {
      const id = sectionName.slice('boards.'.length);
      const section = doc[sectionName];
      boards.set(id, {
        id,
        name: String(section['name'] || `Board ${id}`),
        displayOrder: Number(section['display_order'] ?? boards.size + 1),
        createdAt: String(section['created_at'] || new Date().toISOString()),
        updatedAt: String(section['updated_at'] || new Date().toISOString()),
        hostedBy: String(section['hosted_by'] || ''),
        hostedSince: String(section['hosted_since'] || ''),
      });
    }
  }

  // [assets.{uuid}]
  const assets = new Map<string, ImportedAssetInfo>();
  for (const sectionName of Object.keys(doc)) {
    if (sectionName.startsWith('assets.')) {
      // assets."uuid" の形式を処理
      let uuid = sectionName.slice('assets.'.length);
      if (uuid.startsWith('"') && uuid.endsWith('"')) {
        uuid = uuid.slice(1, -1);
      }
      const section = doc[sectionName];
      assets.set(uuid, {
        uuid,
        originalPath: String(section['original_path'] || ''),
        importedBy: String(section['imported_by'] || ''),
        importedAt: String(section['imported_at'] || new Date().toISOString()),
        mimeType: String(section['mime_type'] || 'application/octet-stream'),
        fileSize: Number(section['file_size'] ?? 0),
      });
    }
  }

  return {
    project,
    background,
    collaboration,
    boards,
    assets,
  };
}

// ========================================
// wbasset パーサー
// ========================================

import type { WbAsset, AssetType } from '../types';

/**
 * .wbasset ファイルをパース
 */
export function parseWbasset(content: string): WbAsset | null {
  const doc = parseToml(content);
  const assetSection = doc['asset'];

  if (!assetSection) {
    return null;
  }

  return {
    uuid: String(assetSection['uuid'] || ''),
    type: String(assetSection['type'] || 'board') as AssetType,
    relativePath: String(assetSection['relative_path'] || ''),
    referencedBy: (assetSection['referenced_by'] as string[]) || [],
    allAncestors: (assetSection['all_ancestors'] as string[]) || [],
  };
}
