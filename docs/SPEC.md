# debate-board 仕様書 v1.1

複数のAIと人間が同じボードを囲んで議論し、結論を「決定カード」として残すローカルアプリ。
進行はアルゴリズム（Nodeスクリプト）が担い、AIはヘッドレスCLIまたはローカルLLMのHTTP APIで呼ぶ。

- **議論データは一切外に出ない**: 発言・カード・NOTE・議事録はすべて `state/`（git管理外）に保存。リポジトリにはツールのコードだけが存在する
- **APIキー不要・追加課金なし**: CLI系アダプタは各CLIのローカル認証を使う。コードに秘密情報は含まれない
- **クローンすれば誰でも自分のPC内だけで使える**（サーバは 127.0.0.1 のみ）

## 1. コンセプト

- **エンジン＝スクリプト**。ターン順・トグル判定・カード反映・終了判定は決定的な処理
- **共有記憶＝ボード**。各AIの内部記憶に頼らず、毎ターン「ボード要約＋直近発言」を渡す
- **GUIは画面だけ**。AIを呼ばない。localhostのみで動く

## 2. 参加者（プラガブル）とトグル

参加者は `config.json` で自由に定義する（人数・種類とも可変）。
各参加者: `{id, name, adapter, model?, endpoint?, persona?, enabled, pcAccess?}`。ターン順は配列順。

### model / effort（CLI系は参加者ごとに指定可）

- `model`: claude `--model` / codex `-m` / grok `-m` に渡す。未指定=各CLIの既定を継承
- `effort`: claude `--effort` / codex `-c model_reasoning_effort=` / grok `--reasoning-effort` に渡す。未指定=CLI既定。有効値はCLIごとに異なるためパススルー（不正値はそのターンが pass+error になり発言ログで可視化）

### pcAccess（CLI系アダプタのPCアクセス度合い）

| 値 | 意味 | claude | codex | grok |
|---|---|---|---|---|
| `"read"`（既定） | ファイルを**読める**（議論の根拠にPC内の資料を参照可）。書き込み・実行は不可 | 追加フラグなし（headless既定） | `--sandbox read-only` | `--permission-mode plan --max-turns 6` |
| `"full"` | 読み書き・実行まで許可（**明示オプトイン・自己責任**） | `--permission-mode bypassPermissions` | `--sandbox danger-full-access` | `--permission-mode bypassPermissions --max-turns 10` |

ollama / openai-compat / human はHTTP・GUIのみでPCに触れないため対象外（指定は無視）。
grokの `--max-turns` はツール使用の周回上限（1発言の所要時間ガード。ファイル参照の周回分を確保しつつ暴走探索を防ぐ）。

### アダプタ種別

| adapter | 実体 | 用途 |
|---|---|---|
| `claude` | `claude -p --output-format json` | Claude系（サブスクCLI） |
| `codex` | `codex exec --json --output-schema` | GPT/Codex系（サブスクCLI） |
| `grok` | `grok -p --json-schema --system-prompt-override` | Grok系（サブスクCLI） |
| `ollama` | `POST http://127.0.0.1:11434/api/chat`（組み込みfetch） | ローカルLLM（Ollama） |
| `openai-compat` | `POST <endpoint>/v1/chat/completions`（組み込みfetch） | LM Studio / llama.cpp server / vLLM 等 |
| `human` | GUI入力欄 | 人間（入力待ち・スキップ可） |

- 既定構成は `config.example.json`（複製して `config.json` を作る。**config.json はコミットしない**＝ローカル環境依存）
- 各参加者に独立トグル（ON=そのラウンドで発言権が回る）。GUIは参加者数ぶん動的に描画
- トグルはラウンド境界で反映（発言中の切替は次ラウンドから）。ONが2人未満なら開始不可

## 3. まとめNOTE（ボード）＝3レーンかんばん

| レーン | 意味 |
|---|---|
| ✅ decided | 決定事項（全員が前提としてよい） |
| 💬 discussing | 議論中の論点 |
| ⏸ held | 保留（今回は掘らない） |

- カード = `{id, lane, title, body, createdBy, updatedBy, updatedAt}`
- **全員が操作できる**: AIは発言時の構造化出力 `cardOps` で、人間はGUIのドラッグ＆編集で
- cardOps: `add`（レーン指定で新規）/ `move`（レーン移動）/ `edit`（title/body修正）
- 適用はエンジンが機械的に実施。矛盾（存在しないid等）は無視してtranscriptに警告を残す

## 4. 各自NOTE

- 参加者ごとの自由メモ（`notes.<id>`）。自分の思考の継続用（作戦・宿題・根拠リンク）
- 書けるのは本人のみ（AIは出力の `noteUpdate` で、人間はGUIで）。他人のNOTEは読める

## 5. ターンプロトコル（1ラウンド）

ONの参加者に対して config の配列順で:

1. エンジンがプロンプトを組み立てる:
   - お題／ラウンド番号／3レーン要約（各カード title+1行）／自分のNOTE／直近2ラウンドの発言
   - 出力契約（下記JSONスキーマ）
2. アダプタ経由で呼び出し（タイムアウト120s、失敗は1回リトライ、それでも失敗ならpass扱い＋エラー記録）
3. 応答JSONを検証 → cardOps適用 → transcript追記 → state保存 → GUIへSSE通知
4. humanのターン: GUIが入力待ちUIになる。スキップボタンあり。5分無操作で自動pass

### AI応答スキーマ（全アダプタ共通）

```json
{
  "utterance": "発言（日本語、400字以内目安）",
  "cardOps": [{"op": "add|move|edit", "cardId": "c3(move/edit時)", "lane": "decided|discussing|held", "title": "(add/edit)", "body": "(add/edit)"}],
  "noteUpdate": "自分のNOTE全文置換（省略可）",
  "pass": false
}
```

## 6. 終了条件と締め

いずれかで議論終了:
- 規定ラウンド数（既定4、GUIで変更可）に到達
- ONの全AIが同一ラウンドで `pass: true`
- 人間がGUIで「終了」

終了後、**シンセシスターン**（config先頭のAI参加者が担当）:
- decided/held の整理、discussing の残論点list、結論サマリを `summary` としてstateに保存
- GUIに最終レポート表示

## 7. state（正＝ファイル。1議論=1ディレクトリ。**git管理外**）

```
state/<debateId>/board.json       … meta / participants / cards / notes / summary
state/<debateId>/transcript.jsonl … 発言ログ（追記のみ）
```

- 毎ターン後に保存 → プロセス再起動しても続きから再開できる
- `participants.<id>.session` にresume用ID（grok=sessionId等）を保持（v1は未使用でも枠だけ）

## 8. GUI（1ページ）

- ヘッダ: お題／ラウンド表示／開始・一時停止・終了
- 参加者トグルチップ（configから動的生成）
- 3レーンかんばん（ドラッグでlane移動、クリックで編集）
- 右ペイン: transcript（ライブ）／各自NOTEタブ
- humanターン時: 入力欄＋発言/スキップボタン
- 議論終了時: summaryパネル表示（M2ではT5スコープ）

### API契約（GUI⇔server 正式版）

| メソッド/パス | ボディ / 応答 |
|---|---|
| GET `/api/state` | 応答 `{board:{meta:{topic,round,maxRounds,status,endedBy},cards:[{id,lane,title,body,createdBy}],notes:{<pid>:string},summary}, participants:[{id,name,adapter,enabled}], awaitingHuman:null\|{participantId}, transcript:[{round,speaker,text,ts}]}` |
| SSE `/api/events` | `data:{"type":"update"}`（クライアントは/api/state再取得）／`{"type":"await-human","participantId"}`／`{"type":"ended"}` |
| POST `/api/start` | `{topic, maxRounds}`（ONが2人未満なら400） |
| POST `/api/pause` | `{}`（トグル: running⇄paused） |
| POST `/api/end` | `{}` |
| POST `/api/toggle` | `{id, enabled}` |
| POST `/api/card` | `{op:"add"\|"move"\|"edit", cardId?, lane?, title?, body?}`（編集でレーン変更する場合はedit→moveの2リクエスト可） |
| POST `/api/say` | `{text}`（awaitingHuman時のみ有効） |
| POST `/api/skip` | `{}`（同上） |
| POST `/api/note` | `{text}`（human参加者自身のNOTE更新） |

- POST成功応答は最新の `/api/state` と同形を返す（クライアントは即時反映し、SSEは補助通知とする）

## 9. 非機能・セキュリティ・プライバシー

- **依存ゼロ**: Node組み込みのみ（http/fs/child_process/crypto/fetch）。npm install不要。依存追加はオーナー承認＋公開14日ルール適用
- バインドは `127.0.0.1` 固定。認証なし（ローカル専用。外部公開しない）
- **議論データ（`state/`）と `config.json` はコミット対象外**（.gitignore＋CIガードの二重防御）
- progress・テスト・ドキュメントに実際の議論内容を書かない（テストはダミーお題を使う）
- ローカルLLMアダプタのendpointはlocalhost想定。リモートURLを設定する場合は利用者の自己責任
- grok呼び出しは `--system-prompt-override`＋専用 `--cwd`＋`--no-memory`（コーディング用プロンプト回避と記憶汚染防止）
- CLI系参加者のPCアクセスは既定で読み取り専用（`pcAccess: "read"`）。書き込み許可は参加者ごとの明示オプトイン（§2）
- 同時に走る議論は1つ（v1）。Windows/macOS/Linuxで動作（プロセス起動はクロスプラットフォーム対応）

## 10. マイルストーン

| M | 内容 | 完了条件 |
|---|---|---|
| **M1** | エンジン＋CLIアダプタ3種（GUIなし） | ターミナルでAI3者の議論が1回完走し、state に決定カードが残る |
| **M2** | GUI＋SSE＋human参加＋ollama/openai-compat | ブラウザでトグル・かんばん・入力が動き、実議論1回完走 |
| **M3** | 磨き | resume活用・履歴閲覧・summaryのMarkdownエクスポート |
