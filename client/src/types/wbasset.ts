/**
 * Whiteboard Asset Metadata (.wbasset) v2 型定義
 */

// ========================================
// アセットタイプ
// ========================================

export type AssetType = 'board' | 'image' | 'document';

// ========================================
// wbasset 構造
// ========================================

/** .wbasset ファイルの内容 */
export interface WbAsset {
  uuid: string;
  type: AssetType;
  originalName: string;       // 元のファイル名
  mimeType: string;           // MIME type (e.g. "image/png")
  fileSize: number;           // バイト数
  relativePath: string;
  referencedBy: string[];    // このアセットを overlay として載せているボードの UUID
  allAncestors: string[];    // 全ての祖先ボードの UUID（キャッシュ）
}

// ========================================
// アセットインデックス（メモリ上）
// ========================================

/** アセットの逆引きインデックス */
export interface AssetIndex {
  byUuid: Map<string, WbAsset>;
  byPath: Map<string, WbAsset>;
}

/** 空のインデックスを作成 */
export function createAssetIndex(): AssetIndex {
  return {
    byUuid: new Map(),
    byPath: new Map(),
  };
}

/** インデックスにアセットを追加 */
export function addToAssetIndex(index: AssetIndex, asset: WbAsset): void {
  index.byUuid.set(asset.uuid, asset);
  index.byPath.set(asset.relativePath, asset);
}

/** インデックスからアセットを削除 */
export function removeFromAssetIndex(index: AssetIndex, uuid: string): void {
  const asset = index.byUuid.get(uuid);
  if (asset) {
    index.byUuid.delete(uuid);
    index.byPath.delete(asset.relativePath);
  }
}

// ========================================
// 循環参照チェック
// ========================================

/**
 * ボード X を編集中に、アセット Y を overlay として追加できるか判定
 * 
 * @param editingBoardUuid 編集中のボードの UUID
 * @param targetAsset 追加しようとしているアセット
 * @param index アセットインデックス
 * @returns 追加可能なら true
 */
export function canAddAsOverlay(
  editingBoardUuid: string,
  targetAsset: WbAsset,
  index: AssetIndex
): boolean {
  // 自分自身は追加不可
  if (targetAsset.uuid === editingBoardUuid) {
    return false;
  }

  // 編集中ボードの祖先に target が含まれていたら循環になる
  const editingBoard = index.byUuid.get(editingBoardUuid);
  if (!editingBoard) {
    return true; // 編集中ボードが見つからない場合は許可（エラーケース）
  }

  const ancestorsAndSelf = new Set([editingBoardUuid, ...editingBoard.allAncestors]);
  return !ancestorsAndSelf.has(targetAsset.uuid);
}

// ========================================
// all_ancestors 再計算
// ========================================

/**
 * アセットの allAncestors を再計算
 */
export function recalculateAllAncestors(
  asset: WbAsset,
  index: AssetIndex
): string[] {
  const result = new Set<string>();

  for (const parentUuid of asset.referencedBy) {
    result.add(parentUuid);
    const parent = index.byUuid.get(parentUuid);
    if (parent) {
      for (const ancestor of parent.allAncestors) {
        result.add(ancestor);
      }
    }
  }

  return Array.from(result);
}

/**
 * アセットとその全子孫の allAncestors を再計算
 */
export function recalculateAllAncestorsRecursive(
  asset: WbAsset,
  index: AssetIndex
): void {
  asset.allAncestors = recalculateAllAncestors(asset, index);

  // 子孫を探して再計算
  for (const [, a] of index.byUuid) {
    if (a.referencedBy.includes(asset.uuid)) {
      recalculateAllAncestorsRecursive(a, index);
    }
  }
}

// ========================================
// OA/OR イベント時の更新
// ========================================

/**
 * OA イベント発生時のアセット更新
 * 
 * @param parentUuid overlay を追加したボードの UUID
 * @param childAsset 追加されたアセット
 * @param index アセットインデックス
 */
export function onOverlayAdded(
  parentUuid: string,
  childAsset: WbAsset,
  index: AssetIndex
): void {
  // referencedBy に追加
  if (!childAsset.referencedBy.includes(parentUuid)) {
    childAsset.referencedBy.push(parentUuid);
  }

  // allAncestors を再計算
  recalculateAllAncestorsRecursive(childAsset, index);
}

/**
 * OR イベント発生時のアセット更新
 * 
 * @param parentUuid overlay を削除したボードの UUID
 * @param childAsset 削除されたアセット
 * @param index アセットインデックス
 */
export function onOverlayRemoved(
  parentUuid: string,
  childAsset: WbAsset,
  index: AssetIndex
): void {
  // referencedBy から削除
  childAsset.referencedBy = childAsset.referencedBy.filter(id => id !== parentUuid);

  // allAncestors を再計算
  recalculateAllAncestorsRecursive(childAsset, index);
}

// ========================================
// TOML シリアライズ
// ========================================

/** wbasset を TOML 文字列に変換 */
export function wbassetToToml(asset: WbAsset): string {
  const lines: string[] = [
    '[asset]',
    `uuid = "${asset.uuid}"`,
    `type = "${asset.type}"`,
    `original_name = "${asset.originalName}"`,
    `mime_type = "${asset.mimeType}"`,
    `file_size = ${asset.fileSize}`,
    `relative_path = "${asset.relativePath}"`,
    `referenced_by = [${asset.referencedBy.map(s => `"${s}"`).join(', ')}]`,
    `all_ancestors = [${asset.allAncestors.map(s => `"${s}"`).join(', ')}]`,
  ];
  return lines.join('\n');
}
