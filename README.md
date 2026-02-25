# Whiteboard Project App (P2P)

`.wbproj` 形式のプロジェクトを管理・編集するホワイトボードアプリケーション。

## 特徴

- **プロジェクト管理**: 複数のボードを1つのプロジェクトとして管理
- **wbelx 対応**: ストローク + オーバーレイのイベントソーシング（デルタ記録方式 + BATCH）
- **P2P 同期**: Yjs + WebRTC によるリアルタイム共同編集
- **投げ縄 (Lasso)**: フリーフォーム範囲選択・一括移動・一括削除・コピー＆ペースト
- **Undo/Redo**: セッション単位の操作履歴。BATCH 対応
- **ZIP アーカイブ**: .wbproj 形式でエクスポート/インポート

## 対応ファイル形式

| 形式 | 説明 |
|------|------|
| `.wbproj` | プロジェクトファイル（ZIP アーカイブ） |
| `.wbelx` | 拡張ホワイトボード（オーバーレイ対応） |
| `.wbel` | 標準ホワイトボード（ストロークのみ、読込時に wbelx に変換） |

## ディレクトリ構造

```
wbproj-app-p2p/
├── server/
│   ├── package.json
│   └── index.js                     # y-webrtc 互換シグナリングサーバー
└── client/
    ├── package.json
    ├── vite.config.ts
    ├── vitest.config.ts              # テスト設定
    ├── eslint.config.mjs             # ESLint（Core 層制約含む）
    ├── index.html
    ├── scripts/
    │   └── check-core-constraints.sh # Core 層制約チェック（grep ベース）
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── index.css
        ├── types/                    # 型定義
        │   ├── wbel.ts               # wbel v8
        │   ├── wbelx.ts              # wbelx v4
        │   ├── wbasset.ts            # wbasset v2
        │   ├── project.ts            # project.toml 型定義
        │   ├── overlay-display.ts    # オーバーレイ表示状態
        │   └── index.ts
        ├── core/                     # ドメインロジック層（Rust 移植対象）
        │   ├── CORE_RULES.md         # 制約ドキュメント
        │   ├── types.ts              # 型 re-export
        │   ├── state-machine.ts      # イベントリプレイ → 現在状態
        │   ├── undo-engine.ts        # Undo/Redo エンジン
        │   ├── event-builders.ts     # Undo/Redo サブイベント生成
        │   ├── lasso-engine.ts       # 投げ縄操作ロジック
        │   ├── snapshot-builder.ts   # スナップショット構築
        │   ├── minimize.ts           # wbelx Minimize
        │   ├── overlay-ops.ts        # z-index / viewport 操作
        │   ├── bg-delta.ts           # 背景デルタ計算
        │   ├── color.ts              # sRGB 色空間計算
        │   ├── lock-manager.ts       # P2P オブジェクトロック
        │   ├── stroke-renderer.ts    # ストローク描画
        │   ├── board-renderer.ts     # ボード描画
        │   ├── render-context.ts     # 描画抽象化
        │   └── __tests__/            # Core 層テスト
        ├── utils/                    # ユーティリティ
        │   ├── wbelx-parser.ts       # JSONL パース / シリアライズ
        │   ├── toml-parser.ts        # project.toml パーサー
        │   ├── project.ts            # プロジェクト操作
        │   ├── storage.ts            # IndexedDB ストレージ
        │   ├── pipeline.ts           # 曲線フィッティングパイプライン
        │   ├── bezier-fitter.ts      # Schneider 法ベジェフィッティング
        │   ├── corner-detector.ts    # コーナー検出
        │   ├── curve-types.ts        # 曲線型定義
        │   ├── math.ts              # 数学ユーティリティ
        │   ├── export.ts             # PNG / SVG エクスポート
        │   ├── thumbnail.ts          # サムネイル生成
        │   ├── p2p-asset-protocol.ts # P2P アセット転送プロトコル
        │   ├── common.ts             # ID 生成 / タイムスタンプ
        │   ├── config.ts             # アプリ設定
        │   ├── pdf.ts                # PDF ユーティリティ
        │   ├── index.ts
        │   └── __tests__/            # Utils テスト
        ├── hooks/                    # React Hooks（Shell 層）
        │   ├── useYjsSync.ts         # Yjs 同期
        │   ├── useProjectStore.ts    # プロジェクト状態管理 (Zustand)
        │   ├── useUndoRedo.ts        # Undo/Redo Hook
        │   ├── useCanvasInput.ts     # 入力処理
        │   ├── useCanvasGesture.ts   # ジェスチャ認識
        │   ├── useOverlayOps.ts      # オーバーレイ操作
        │   ├── useOverlayDisplay.ts  # オーバーレイ表示状態
        │   ├── useLassoOps.ts        # 投げ縄操作
        │   ├── useObjectLock.ts      # P2P ロック
        │   ├── useP2pAssetTransfer.ts # P2P アセット転送
        │   ├── usePersistence.ts     # 永続化
        │   ├── useBackground.ts      # 背景設定
        │   └── useKeyboard.ts        # キーボードショートカット
        ├── components/
        │   ├── WhiteboardCanvas.tsx   # Canvas 描画
        │   ├── Toolbar.tsx            # ツールバー
        │   ├── OverlayInlineControls.tsx # インラインコントロール
        │   ├── ViewportEditor.tsx     # Viewport 編集
        │   ├── ViewportEditorBoard.tsx
        │   ├── ViewportEditorImage.tsx
        │   ├── ViewportEditorPdf.tsx
        │   └── LassoActionBar.tsx     # 投げ縄アクションバー
        ├── pages/
        │   ├── HomePage.tsx           # ホーム
        │   ├── ProjectDashboard.tsx   # プロジェクトダッシュボード
        │   └── BoardEditor.tsx        # ボードエディタ
        └── tests/
            └── p2p-asset-protocol.test.ts
```

## セットアップ

```bash
# サーバー
cd server
npm install
npm start            # ws://localhost:4444

# クライアント
cd client
npm install
npm run dev          # http://localhost:3000
```

## 開発コマンド

```bash
npm run dev          # 開発サーバー起動
npm run build        # プロダクションビルド
npm test             # テスト実行（vitest）
npm run test:watch   # テスト監視モード
npm run lint         # ESLint 実行
npm run lint:fix     # ESLint 自動修正
npm run check:core   # Core 層制約チェック（grep ベース）
```

## アーキテクチャ

```
L4  プラットフォーム入力層  [固有]  タッチ / ペン入力の取得・正規化
L3  UI シェル層            [固有]  React Hooks, Yjs 同期, UI コンポーネント
L2  ストローク処理・描画層  [共有]  曲線フィッティング, イベント生成, 描画
L1  コアロジック層          [共有]  state-machine, undo-engine, lasso-engine 等
```

- `src/core/` = L1/L2。React・Yjs・ブラウザ API に非依存。Rust 移植対象。ESLint で制約を自動検証。
- `src/hooks/` + `src/components/` + `src/pages/` = L3。React + Yjs に依存。

## 画面構成

1. **Home**: プロジェクト新規作成 / ファイルを開く
2. **Project Dashboard**: ボード一覧、アセット管理、背景設定、エクスポート
3. **Board Editor**: ボード編集（描画、消去、オーバーレイ、投げ縄、Undo/Redo）

## 実装状況

- [x] P2P 同期（Yjs + WebRTC）
- [x] オーバーレイ操作（OA/OR/OT/OV/OS イベント）
- [x] アセットインポート（画像、PDF）
- [x] Undo/Redo（BATCH 対応、非同期構築）
- [x] 投げ縄（フリーフォーム選択）— 一括移動・削除・コピー＆ペースト
- [x] 背景パターン設定 UI（dots / grid / lines）
- [x] Export as PNG / SVG
- [x] サムネイル生成
- [x] P2P オブジェクトロック
- [x] P2P アセット転送
- [x] キャンバスサイズ設定（CS イベント）
- [x] Minimize（イベント履歴圧縮）
- [ ] ホワイトボードサイズ指定 UI（ボード作成時のプリセット選択）
- [ ] TeX/LaTeX 組版（KaTeX）
- [ ] TikZ 図表生成
- [ ] テキストツール
- [ ] 図形ツール

## テスト

```
12 ファイル / 184 テスト（vitest）

core/   — state-machine, undo-engine, event-builders, lasso-engine,
          snapshot-builder, overlay-ops, bg-delta, color, lock-manager
utils/  — wbelx-parser, minimize, statemachine(統合)
tests/  — p2p-asset-protocol
```

## 仕様書

| 仕様書 | バージョン | 説明 |
|--------|-----------|------|
| `.wbel` Specification | v8 | ストロークイベント（D, E, S, BATCH） |
| `.wbelx` Specification | v4 | wbel 拡張（OA, OR, OT, OV, OS, BG, CS） |
| `.wbasset` Specification | v2 | アセットメタデータ |
| `.wbproj` Specification | v4 (file format v4.0) | プロジェクトコンテナ |
| Application Specification | v3 | アプリケーション機能仕様 |
| Implementation Guide | v4 | 実装ガイドライン |
| Architecture Specification | v1.4 | マルチプラットフォーム方式定義 |
