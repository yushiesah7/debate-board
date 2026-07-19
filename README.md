# debate-board

複数のAIと人間が同じボードで議論して、結論をカンバン（✅決定／💬議論中／⏸保留）に残すローカルアプリ。

- 進行はNodeスクリプト（アルゴリズム）、AIはヘッドレスCLI（Claude Code / Codex / Grok）またはローカルLLM（Ollama / OpenAI互換API）
- **議論の中身は一切外に出ない**: 発言・カード・議事録はすべて `state/`（git管理外）に保存。サーバは 127.0.0.1 のみ
- **APIキー不要**: CLI系は各CLIのローカル認証を流用（コードに秘密情報なし）
- **依存パッケージゼロ**: Node組み込みのみ。`npm install` 不要

## 使い方（M2以降）

```
cp config.example.json config.json   # 参加者を編集（人数・種類は自由）
node src/server.mjs
# → http://127.0.0.1:8787
```

参加者はトグルでON/OFF。ONの参加者だけでラウンドが回り、終了時に結論サマリが残る。

## ドキュメント

- 仕様: [docs/SPEC.md](docs/SPEC.md)
- 構成: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- タスク: [docs/TASKS.md](docs/TASKS.md)
- 進捗: [progress/PROGRESS.md](progress/PROGRESS.md)
