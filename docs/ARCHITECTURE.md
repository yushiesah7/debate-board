# debate-board アーキテクチャ v1

## 構成図

```
┌─ server.mjs (Node, 127.0.0.1:8787) ─────────────────┐
│  static配信(public/) + REST + SSE                     │
│  ┌─ engine.mjs ──────────────────────────────┐      │
│  │ ラウンドループ／プロンプト組立／cardOps適用   │      │
│  │ 終了判定／シンセシス／state保存              │      │
│  └──┬─────────────────────────────────────┘      │
│     │ adapter I/F: speak(ctx) → TurnResult           │
│  ┌──┴────────┬─────────────┬─────────────┐        │
│  │ claude.mjs │ codex.mjs   │ grok.mjs     │ human.mjs│
│  │ (凪)       │ (アキ)      │ (ロキ)       │ (GUI待ち)│
│  └───────────┴─────────────┴─────────────┘        │
└───────────────┬──────────────────────────────────┘
                │ fs (JSON/JSONL)
        state/<debateId>/…          public/index.html (vanilla JS)
```

## モジュールと責務

| ファイル | 責務 | 依存 |
|---|---|---|
| `src/server.mjs` | http起動、public配信、REST/SSE、engineの起動・停止 | node:http, fs |
| `src/engine.mjs` | ラウンド進行の純ロジック。**CLIもhttpも知らない**（アダプタ注入） | なし（純JS） |
| `src/state.mjs` | board.json/transcript.jsonl の読み書き・スキーマ検証・ID採番 | node:fs, crypto |
| `src/prompt.mjs` | ボード要約・ターンプロンプト・シンセシスプロンプトの組立（全アダプタ共通） | なし |
| `src/adapters/claude.mjs` | `claude -p <prompt> --output-format json --model <m> --system-prompt <persona>` | child_process |
| `src/adapters/codex.mjs` | `codex exec --json --output-schema <schema.json> --skip-git-repo-check -C <dir>` | child_process |
| `src/adapters/grok.mjs` | `grok -p <prompt> --json-schema <inline> --system-prompt-override <persona> --cwd <dir> --no-memory --disable-web-search --permission-mode dontAsk` | child_process |
| `src/adapters/ollama.mjs` | `POST <endpoint>/api/chat`（format: json指定） | 組み込みfetch |
| `src/adapters/oai.mjs` | `POST <endpoint>/v1/chat/completions`（response_format json）— LM Studio / llama.cpp server / vLLM | 組み込みfetch |
| `src/adapters/human.mjs` | Promise保留→ /api/say か skip で解決。タイムアウト付き | なし |
| `src/config.mjs` | config.json 読み込み・検証・既定値補完（config.example.json フォールバック） | node:fs |
| `public/index.html` | GUI一式（HTML+CSS+JS 1ファイル、ビルドなし） | なし |

## アダプタ共通I/F

```js
// ctx: {debateId, topic, round, persona, boardSummary, ownNote, recentTranscript, schema}
// 戻り: {utterance, cardOps[], noteUpdate?, pass, raw?, error?}
async function speak(ctx) {}
```

- 呼び出しは `child_process.spawn`（shell:false、引数配列渡し — Windowsのエスケープ地獄回避）
- 長いプロンプトは stdin か一時ファイル渡し（コマンドライン長制限対策）
- タイムアウト120s → kill → 1リトライ → 失敗は `{pass:true, error}` で返す（エンジンは止まらない）
- 応答パース: 各CLIの出力エンベロープ差はアダプタ内で吸収し、共通TurnResultに正規化する

## CLI実測メモ（2026-07-19検証済み）

| CLI | 確認済みフラグ | 備考 |
|---|---|---|
| claude 2.1.215 | `-p/--print`, `--output-format json`, `--model`, `--system-prompt` | ネイティブ版。応答はJSONエンベロープ |
| codex 0.144.1 | `exec`(非対話), `--json`, `--output-schema <FILE>`, `--skip-git-repo-check` | ChatGPTログイン認証 |
| grok 0.2.103 | `-p`, `--json-schema`(inline), `--output-format json`, `--system-prompt-override`, `--no-memory`, `--cwd`, `--max-turns` | 実測9s/turn、`structuredOutput`と`sessionId`が返る。素のsystem promptは約15kトークン→overrideで回避 |

## 設計判断（理由つき）

1. **依存ゼロ** — 14日ルールの完全回避＋セットアップ不要。SSEもかんばんDnDも素のWeb APIで足りる規模
2. **engine純ロジック化** — アダプタをフェイク差し替えでき、AI呼び出しなしでループの単体テストができる
3. **stateはファイル** — 再起動復帰・議事録がそのまま成果物・デバッグが目視でできる。DBは過剰
4. **ボード要約を毎ターン注入（resume非依存）** — 参加者の途中ON/OFFでも文脈が壊れない。resumeはM3の最適化
5. **ポート8787** — UnityMCP(8080)等との衝突回避
6. **プラガブル参加者** — CLI勢もローカルLLMも同じTurnResultに正規化。HTTP系はNode組み込みfetch（依存ゼロ維持）。参加者定義はconfig.jsonでユーザーが自由に組める

## テスト方針

- `test/engine.test.mjs`: フェイクアダプタでラウンド進行・cardOps適用・終了判定・pass処理を検証（`node --test`）
- アダプタは実CLIスモーク（各1呼び出し、`test/smoke-adapters.mjs`、手動実行）
- M1完了条件 = 実3AIでの完走ログを `progress/` に添付
