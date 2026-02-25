# Core Layer Rules (`src/core/`)

> whiteboard-architecture-spec v1.4 §3 に基づく制約

## 目的

`src/core/` は Rust/wasm 移植対象の純粋ドメインロジック層。
プラットフォーム依存を排除し、単体テスト可能な純粋関数で構成する。

## 制約

| # | ルール | 理由 |
|---|--------|------|
| 1 | `react`, `react-dom` import 禁止 | React 非依存 |
| 2 | `yjs`, `y-*` import 禁止 | Yjs は Shell 層の責務 |
| 3 | `document`, `window` 等ブラウザ API 直接使用禁止 | Node/Rust 環境互換 |
| 4 | 副作用禁止（IO, ネットワーク, タイマー） | 純粋関数のみ |
| 5 | ID 生成・タイムスタンプは引数で注入 | テスタビリティ |

## 許容される依存

- `../types` (型定義の re-export)
- Core 層内部モジュール間の import（`./serializer` 等）

## 検証

```bash
bash scripts/check-core-constraints.sh
```

## モジュール一覧

| Module | 元ファイル | 責務 |
|--------|-----------|------|
| `types.ts` | types/index.ts | 型 re-export |
| `serializer.ts` | utils/wbelx-parser.ts | JSONL シリアライゼーション |
| `color.ts` | BoardEditor.tsx | sRGB 色空間計算 |
| `bg-delta.ts` | BoardEditor.tsx | BG delta 計算 |
| `event-builders.ts` | useYjs.ts | Undo/Redo sub-event 生成 |
| `undo-engine.ts` | hooks/useYjs.ts | Undo/Redo エンジン |
| `overlay-ops.ts` | BoardEditor.tsx | z-index / viewport 操作 |
| `lasso-engine.ts` | BoardEditor + useYjs | Lasso 選択・操作 |
| `lock-manager.ts` | (新規) | P2P オブジェクトロック |
| `snapshot-builder.ts` | BoardEditor.tsx | スナップショット構築 |
| `render-context.ts` | (新規) | 描画抽象化 |
| `board-renderer.ts` | BoardEditor.tsx | ボード描画ロジック |
| `stroke-renderer.ts` | BoardEditor.tsx | ストローク描画 |
| `state-machine.ts` | utils/statemachine.ts | イベントリプレイ |
| `minimize.ts` | utils/minimize.ts | wbelx 最小化 |
