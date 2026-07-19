# 実装タスク分割（フェーズ2用）

凪(Fable)が司令塔。実装はプチ凪(Sonnet)並列、レビューはアキ＋ロキ。
**着手ルール**: 各タスクは SPEC.md / ARCHITECTURE.md に従う。I/F変更が必要になったら実装前に司令塔へ差し戻す。

## Wave 1（並列3本・互いに独立）

| # | タスク | 成果物 | 受け入れ条件 |
|---|---|---|---|
| T1 | state + engine 純ロジック | `src/state.mjs`, `src/engine.mjs`, `src/prompt.mjs`, `test/engine.test.mjs` | `node --test` 緑。フェイクアダプタで4ラウンド完走・cardOps適用・全AIpass終了・不正cardOps無視を検証 |
| T2 | アダプタ3種 + human | `src/adapters/*.mjs`, `test/smoke-adapters.mjs` | スモークで3CLIとも正規化TurnResultが返る（スキーマ準拠・タイムアウト・リトライ動作含む） |
| T3 | GUI | `public/index.html`（モックstate同梱） | モックJSONでかんばん表示・DnD・トグル・transcript描画が動く（サーバ不要のスタンドアロン確認） |

## Wave 2（Wave 1マージ後）

| # | タスク | 成果物 | 受け入れ条件 |
|---|---|---|---|
| T4 | server 結線 | `src/server.mjs` | REST/SSE経由でT1+T2+T3が繋がり、M1完走（ターミナル）→M2完走（ブラウザ） |
| T5 | シンセシス＋summary表示 | engine拡張 + GUI | 終了後にsummaryがstateに保存されGUIに出る |

## レビュー運用（ai-review布陣）

- 各WaveのPR単位で: アキ `/codex:review` ＋ ロキ `grok --permission-mode plan -p`（読み取り専用）
- 指摘は凪が突き合わせて仕分け（今すぐ直す／M3送り／POC許容）
- 両者一致の指摘は最優先（本命バグ率が高い実績）

## 進捗記録

- 継続: `progress/PROGRESS.md`（統一フォーマット・記録者タグ）
- 節目: `progress/{YYYY-MM-DD}-題名.md`
- 更新したら `Lab\work_progress\PROGRESS.md`（ダッシュボード）の行も1行更新
