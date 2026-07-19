# debate-board — エージェント向けメモ

4人議論ボード（凪・アキ・ロキ・yushi）。仕様は `docs/SPEC.md`、構成は `docs/ARCHITECTURE.md`、タスクは `docs/TASKS.md` を必読。
PC共通ルールの正本は `C:\Users\yushi\Lab\notes\agents-common.md`。

## このリポのルール

- **依存ゼロ方針**: Node組み込みのみ。npmパッケージ追加はyushiさん承認＋14日ルール必須
- **進捗**: `progress/PROGRESS.md`（統一フォーマット・記録者タグ・追記のみ）。節目は `progress/{YYYY-MM-DD}-題名.md`。更新時はLabダッシュボード（`Lab\work_progress\PROGRESS.md`）の行も更新
- **state/ はコミットしない**（.gitignore済み。議論ログは実行時生成物）
- **I/F（アダプタ契約・stateスキーマ）を変えるときは実装前に司令塔（凪）へ相談**
- テスト: `node --test`（engine系）。アダプタは `test/smoke-adapters.mjs` を手動実行
- サーバは `127.0.0.1:8787` 固定（8080はUnityMCPと衝突するため使わない）
