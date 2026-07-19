# debate-board PROGRESS

## 2026-07-19 フェーズ1: 仕様・設計・リポ雛形（記録者: 凪）

- 何を変えたか:
  - リポ新設＋git init。docs/SPEC.md（仕様v1）、docs/ARCHITECTURE.md（構成・CLI実測メモ・設計判断）、docs/TASKS.md（Sonnet並列用タスク分割）、AGENTS.md、README.md を作成
  - 事前検証済みの前提: 3AIともヘッドレス構造化出力対応（claude `-p --output-format json`／codex `exec --output-schema`／grok `--json-schema`、grokは実測9s/turn・sessionId回収可）
  - 主要設計判断: エンジン=純ロジック（アダプタ注入）／state=ファイル／依存ゼロ／ボード要約毎ターン注入（resume非依存）／port 8787
- 意図的に触らなかったもの: 実装コード（フェーズ2でSonnet並列に委譲）。resume活用・エクスポートはM3送り
- 完了・未完了: フェーズ1完了（仕様・設計・雛形・初回コミット）。実装は未着手
- 次に確認すべきこと: Wave 1（T1 engine／T2 adapters／T3 GUI）をSonnet3並列で発注 → アキ＋ロキでレビュー。effortはmediumで十分
