# debate-board PROGRESS

## 2026-07-20 (2) pcAccess・model/effort・参加者設定GUI（記録者: 凪)

- 何を変えたか:
  - `pcAccess`（read既定/full）: 参加AIのPCアクセス度合いを参加者ごとに選択制に（read=ファイル参照可・書込不可、full=明示オプトイン）。grokのmax-turnsをread=6/full=10へ
  - `model`/`effort` を全CLIアダプタで参加者ごとに指定可能に（grokはmodel対応自体が新規）。config.exampleにeffort:"medium"を推奨明示
  - 参加者設定GUI: 各チップ⚙→モーダル（datalist候補+自由入力）、POST /api/participant 新設、config.jsonへ原子的永続化、実行中は次ターン反映
  - 既存バグ2件修正: createDebateのpcAccess/effort引継ぎ漏れ（実行時に効かない）、8787の残存サーバプロセス掃除
  - 候補自動発見（GET /api/options）: codex=models_cache.json／grok=`grok models`／ollama=/api/tags／oai=/v1/models から実環境のモデル候補を収集し⚙モーダルのdatalistに反映（10分キャッシュ・失敗は静的フォールバック）。EADDRINUSE時の日本語ガイドも追加
  - 検証: テスト131件全緑、実CLIスモーク3種、effort有効での実3AI議論完走、APIライブ確認（POST反映＋config永続化）
- 意図的に触らなかったもの: web検索の開閉オプション（pcAccessとは別軸。要望があれば追加）、/api/toggleの404/400不整合（既存仕様のまま）
- 完了・未完了: 完了。push済み（main 0aa2bd6）
- 次に確認すべきこと: ブラウザで⚙モーダルの操作感（yushiさん）。M3候補: 履歴閲覧・サマリMarkdownエクスポート・web検索トグル

## 2026-07-20 M1/M2完成 — 実3AI議論の完走（記録者: 凪）

- 何を変えたか:
  - Wave1（PR#1 engine / #2 GUI / #3 adapters）とWave2（PR#4 server+CLI+summary）を全レビュー対応の上マージ。最終テスト106件全緑
  - レビュー体制の実績: ロキ×3回（計47件指摘、うちCritical3）、アキ×2回（実プロセス再現テスト付きでP1×5）、CodeRabbit（有効1件=a11y）。「両者一致=本命」則が2回的中
  - 統合グルー修正2件（ctx.promptText契約統一・シンセシス出力をTurnResult化）
  - **M1達成**: `node src/cli.mjs "お題" 1` で凪(claude)×アキ(codex)×ロキ(grok)の実議論が完走。カード追加→decided移動→結論サマリ生成まで確認（お題例: バーチャル背景vs実写→「用途で使い分け」で合意形成）
  - **M2達成（API検証）**: server起動→GUI配信(200)→/api/state→404処理を確認。GUI操作系はモック＋server統合テスト10件でカバー
  - 実CLI知見: codex execはMCP無効化(`-c mcp_servers={}`)推奨・turn.failedでもexit 0・厳格スキーマ必須（配列にitems）。grokの`-p`は読み→答えは安定、長い実装は途切れる（実装はSonnet向き）
  - 掃除: worktree4本とfeatureブランチ（ローカル/リモート）削除
- 意図的に触らなかったもの: M3（resume活用・履歴閲覧・エクスポート）、ollama/oaiの実機スモーク（ローカルLLM未起動のため。ユニットはモックで検証済み）
- 完了・未完了: M1/M2完了。ブラウザでの実操作確認はyushiさんの初回起動時に
- 次に確認すべきこと: `cp config.example.json config.json`（済）→ `node src/server.mjs` → http://127.0.0.1:8787 でGUI議論を1回遊んでみる。良ければM3へ

## 2026-07-20 仕様v1.1＋GitHub公開（記録者: 凪）

- 何を変えたか:
  - 仕様v1.1: 参加者をconfig.json定義にプラガブル化（ollama/openai-compat追加＝ローカルLLM参加可、組み込みfetchで依存ゼロ維持）、GUIトグルを動的生成に
  - 公開ハードニング: 個人名・絶対パスをスクラブ（grep検証済み）、黙秘ルール（実議論内容をコミット物に書かない）、CIガード（state/・config.jsonの混入で落ちる）
  - GitHub公開: https://github.com/yushiesah7/debate-board （public、2コミットpush済み）
- 意図的に触らなかったもの: 実装コード（Wave 1でSonnet=T1/アキ=T2/ロキ=T3の並列予定）
- 完了・未完了: 公開まで完了。ブランチ保護設定は未（Wave 1のPR運用開始時に設定）
- 次に確認すべきこと: Wave 1発注→feature branch→PR→CodeRabbit発火確認＋アキ・ロキ相互レビュー

## 2026-07-19 フェーズ1: 仕様・設計・リポ雛形（記録者: 凪）

- 何を変えたか:
  - リポ新設＋git init。docs/SPEC.md（仕様v1）、docs/ARCHITECTURE.md（構成・CLI実測メモ・設計判断）、docs/TASKS.md（Sonnet並列用タスク分割）、AGENTS.md、README.md を作成
  - 事前検証済みの前提: 3AIともヘッドレス構造化出力対応（claude `-p --output-format json`／codex `exec --output-schema`／grok `--json-schema`、grokは実測9s/turn・sessionId回収可）
  - 主要設計判断: エンジン=純ロジック（アダプタ注入）／state=ファイル／依存ゼロ／ボード要約毎ターン注入（resume非依存）／port 8787
- 意図的に触らなかったもの: 実装コード（フェーズ2でSonnet並列に委譲）。resume活用・エクスポートはM3送り
- 完了・未完了: フェーズ1完了（仕様・設計・雛形・初回コミット）。実装は未着手
- 次に確認すべきこと: Wave 1（T1 engine／T2 adapters／T3 GUI）をSonnet3並列で発注 → アキ＋ロキでレビュー。effortはmediumで十分
