# debate-board 仕様書 v1

4人（凪=Claude / アキ=Codex / ロキ=Grok / yushi=人間）が同じボードを囲んで議論し、
結論を「決定カード」として残すローカルアプリ。進行はアルゴリズム（Nodeスクリプト）が担い、
AIはヘッドレスCLIで呼ぶ。**追加API課金ゼロ**（3AIともサブスク認証のCLI）。

## 1. コンセプト

- **エンジン＝スクリプト**。ターン順・トグル判定・カード反映・終了判定は決定的な処理
- **共有記憶＝ボード**。各AIの内部記憶に頼らず、毎ターン「ボード要約＋直近発言」を渡す
- **GUIは画面だけ**。AIを呼ばない（課金・秘密情報なし）。localhostのみで動く

## 2. 参加者とトグル

| 参加者 | 実体 | 呼び方 | 参加時 |
|---|---|---|---|
| 凪 | `claude -p --output-format json` | headless | 自動 |
| アキ | `codex exec --json --output-schema` | headless | 自動 |
| ロキ | `grok -p --json-schema --system-prompt-override` | headless | 自動 |
| yushi | GUI入力欄 | 人間 | 手動（入力待ち。スキップ可） |

- 各参加者に独立トグル（ON=そのラウンドで発言権が回る）。既定: 凪ON・アキON・ロキON・yushiOFF
- トグルはラウンド境界で反映（発言中の切替は次ラウンドから）
- ONが2人未満なら開始不可

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

- 参加者ごとの自由メモ（`notes.<who>`）。自分の思考の継続用（作戦・宿題・根拠リンク）
- 書けるのは本人のみ（AIは出力の `noteUpdate` で、yushiはGUIで）。他人のNOTEは読める

## 5. ターンプロトコル（1ラウンド）

ONの参加者に対して固定順（凪→アキ→ロキ→yushi）で:

1. エンジンがプロンプトを組み立てる:
   - お題／ラウンド番号／3レーン要約（各カード title+1行）／自分のNOTE／直近2ラウンドの発言
   - 出力契約（下記JSONスキーマ）
2. アダプタ経由でCLI呼び出し（タイムアウト120s、失敗は1回リトライ、それでも失敗ならpass扱い＋エラー記録）
3. 応答JSONを検証 → cardOps適用 → transcript追記 → state保存 → GUIへSSE通知
4. yushiのターン: GUIが入力待ちUIになる。スキップボタンあり。5分無操作で自動pass

### AI応答スキーマ（3AI共通）

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
- yushiがGUIで「終了」

終了後、**シンセシスターン**（凪が担当。凪OFF時はアキ）:
- decided/held の整理、discussing の残論点list、結論サマリを `summary` としてstateに保存
- GUIに最終レポート表示

## 7. state（正＝ファイル。1議論=1ディレクトリ）

```
state/<debateId>/board.json    … meta / participants / cards / notes / summary
state/<debateId>/transcript.jsonl … 発言ログ（追記のみ）
```

- 毎ターン後に保存 → プロセス再起動しても続きから再開できる
- `participants.<who>.session` にresume用ID（ロキ=sessionId等）を保持（v1は未使用でも枠だけ）

## 8. GUI（1ページ）

- ヘッダ: お題／ラウンド表示／開始・一時停止・終了
- トグル4チップ（凪・アキ・ロキ・yushi）
- 3レーンかんばん（ドラッグでlane移動、クリックで編集）
- 右ペイン: transcript（ライブ）／各自NOTEタブ
- yushiターン時: 入力欄＋発言/スキップボタン
- 更新はSSE（Server-Sent Events）。REST: /api/start, /api/toggle, /api/card, /api/say, /api/end

## 9. 非機能・制約

- **依存ゼロ**: Node組み込みのみ（http/fs/child_process/crypto）。npm install不要 → 14日ルール完全回避。依存追加はyushiさん承認＋14日ルール適用
- バインドは `127.0.0.1` のみ。認証なし（ローカル専用）
- ロキ呼び出しは `--system-prompt-override`（コーディング用15kプロンプト回避）＋ 専用 `--cwd`（state外の隔離dir）＋ `--no-memory`
- 同時に走る議論は1つ（v1）
- Windows前提（パス・プロセス起動はWindows対応必須）

## 10. マイルストーン

| M | 内容 | 完了条件 |
|---|---|---|
| **M1** | エンジン＋3アダプタ（GUIなし） | ターミナルで凪×アキ×ロキの議論が1回完走し、state に決定カードが残る |
| **M2** | GUI＋SSE＋yushi参加 | ブラウザでトグル・かんばん・入力が動き、実議論1回完走 |
| **M3** | 磨き | resume活用・履歴閲覧・summaryのMarkdownエクスポート |
