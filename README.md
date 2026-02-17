# Whiteboard Project App (P2P)

`.wbproj` 形式のプロジェクトを管理・編集するホワイトボードアプリケーション。

## 特徴

- **プロジェクト管理**: 複数のボードを1つのプロジェクトとして管理
- **wbelx 対応**: ストローク + オーバーレイのイベントソーシング
- **P2P 同期**: WebRTC によるリアルタイム共同編集（計画中）
- **ZIP アーカイブ**: .wbproj 形式でエクスポート/インポート

## 対応ファイル形式

| 形式 | 説明 |
|------|------|
| `.wbproj` | プロジェクトファイル（ZIP アーカイブ） |
| `.wbelx` | 拡張ホワイトボード（オーバーレイ対応） |
| `.wbel` | 標準ホワイトボード（ストロークのみ） |

## ディレクトリ構造

```
wbproj-app-p2p/
├── server/
│   ├── package.json
│   └── index.js              # シグナリングサーバー
└── client/
    ├── package.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── index.css
        ├── types/
        │   ├── wbel.ts       # wbel v5 型定義
        │   ├── wbelx.ts      # wbelx v1 型定義
        │   ├── wbasset.ts    # wbasset v1 型定義
        │   └── project.ts    # project.toml 型定義
        ├── utils/
        │   ├── common.ts
        │   ├── statemachine.ts
        │   ├── wbelx-parser.ts
        │   ├── toml-parser.ts
        │   ├── project.ts
        │   └── curve-fitting/
        ├── hooks/
        │   └── useProjectStore.ts
        ├── components/
        │   ├── Toolbar.tsx
        │   └── WhiteboardCanvas.tsx
        └── pages/
            ├── HomePage.tsx
            ├── ProjectDashboard.tsx
            └── BoardEditor.tsx
```

## セットアップ

```bash
# サーバー
cd server
npm install
npm start

# クライアント
cd client
npm install
npm run dev
```

## 画面構成

1. **Home**: プロジェクト新規作成 / ファイルを開く
2. **Project Dashboard**: ボード一覧、アセット管理、設定
3. **Board Editor**: ボード編集（描画、オーバーレイ配置）

## 今後の実装予定

- [ ] P2P 同期（Yjs + WebRTC）
- [ ] オーバーレイ操作（OA/OR/OT/OV/OS イベント）
- [ ] アセットインポート（画像、PDF）
- [ ] Undo/Redo
- [ ] サムネイル生成
- [ ] 背景パターン設定

## 仕様書

- `.wbel` v5: Whiteboard Event Log
- `.wbelx` v1: Whiteboard Extended Event Log
- `.wbasset` v1: Whiteboard Asset Metadata
- `.wbproj` v1: Whiteboard Project
