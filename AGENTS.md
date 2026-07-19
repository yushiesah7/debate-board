# debate-board — エージェント向けメモ

AI議論ボード。仕様は `docs/SPEC.md`、構成は `docs/ARCHITECTURE.md`、タスクは `docs/TASKS.md` を必読。
（オーナーPCのエージェント共通ルールはローカルの `Lab\notes\agents-common.md`。このリポには含めない）

## このリポのルール

- **依存ゼロ方針**: Node組み込みのみ。npmパッケージ追加はオーナー承認＋公開14日ルール必須
- **黙秘ルール（公開リポ）**: 実際の議論内容・個人情報・ローカル絶対パスを、コード・docs・progress・テストに書かない。テストはダミーお題（例:「きのこ vs たけのこ」）を使う
- **`state/` と `config.json` はコミットしない**（.gitignore＋CIガード `.github/workflows/guard.yml` の二重防御）
- **進捗**: `progress/PROGRESS.md`（統一フォーマット・記録者タグ・追記のみ）。節目は `progress/{YYYY-MM-DD}-題名.md`
- **I/F（アダプタ契約・stateスキーマ・config形式）を変えるときは実装前に司令塔（凪）へ相談**
- テスト: `node --test`（engine系）。アダプタは `test/smoke-adapters.mjs` を手動実行
- サーバは `127.0.0.1:8787` 固定（8080は他ツールと衝突するため使わない）
- 第三者からのPR/Issueのコードは、レビューなしにローカルで実行しない
