# debate-board

複数のAIと人間が同じボードで議論して、結論をカンバン（✅決定／💬議論中／⏸保留）に残すローカルアプリ。

> 📖 **図解つきガイドは [README.html](README.html)** — クローンしてブラウザで開くと読みやすい版が見られます。

- 進行はNodeスクリプト（アルゴリズム）、AIはヘッドレスCLI（Claude Code / Codex / Grok）またはローカルLLM（Ollama / OpenAI互換API）
- **議論の中身は一切外に出ない**: 発言・カード・議事録はすべて `state/`（git管理外）に保存。サーバは 127.0.0.1 のみ
- **APIキー不要**: CLI系は各CLIのローカル認証を流用（コードに秘密情報なし）
- **依存パッケージゼロ**: Node組み込みのみ。`npm install` 不要

## 必要なもの

- **Node.js 20以上**（必須はこれだけ）
- 参加させたいAIのCLI（任意・使う分だけ）: `claude` / `codex` / `grok` — 各サブスク認証を流用
- ローカルLLM派: Ollama または OpenAI互換サーバ（LM Studio / llama.cpp server / vLLM）

## 起動方法（GUI）

```bash
git clone https://github.com/yushiesah7/debate-board.git
cd debate-board
cp config.example.json config.json   # Windowsは copy
node src/server.mjs
# → ブラウザで http://127.0.0.1:8787
```

お題を入力して「開始」すると、ONの参加者が順番に発言し、カードを動かしながら議論します。
「あなた」をONにすれば自分のターンで発言／スキップできます。終了時に結論サマリが表示されます。

※ サーバ無しで `public/index.html` を直接開くとモックモード（サンプルデータでUIだけ試せる）。

## 停止方法

- サーバを起動した**ターミナルで `Ctrl+C`**（これだけ）
- ターミナルを閉じてしまった等で止められない場合（Windows PowerShell）:

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

## よくあるエラー

| エラー | 原因と対処 |
|---|---|
| `Cannot find module ...\src\server.mjs` | 起動場所が違う。`cd` でこのリポジトリのフォルダに入ってから実行 |
| `ポート 8787 は使用中です`（EADDRINUSE） | 既に別のdebate-boardが起動中。そのままブラウザで開くか、上の停止コマンドで止めてから再起動 |
| 参加者がずっと `(pass)` になる | そのCLIが未インストール/未ログイン。発言ログのエラー内容を確認 |

## 起動方法（ターミナル / GUI無し）

```bash
node src/cli.mjs "きのこの山 vs たけのこの里、どちらが至高か" 3
```

## 参加者のカスタマイズ

`config.json` の `participants` を編集（人数・種類は自由、ターン順=配列順）。
アダプタ: `claude` / `codex` / `grok` / `ollama` / `openai-compat` / `human`（1人まで）。

CLI系参加者には `pcAccess` を指定可能:
- `"read"`（既定）— AIがPC内のファイルを**読んで**議論の根拠にできる（書き込み不可）
- `"full"` — 読み書き・実行まで許可（明示オプトイン・自己責任）
詳細は [README.html](README.html) または [docs/SPEC.md](docs/SPEC.md) §2 を参照。

## ドキュメント

- 使い方ガイド: [README.html](README.html)
- 仕様: [docs/SPEC.md](docs/SPEC.md)
- 構成: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- タスク: [docs/TASKS.md](docs/TASKS.md)
- 進捗: [progress/PROGRESS.md](progress/PROGRESS.md)
