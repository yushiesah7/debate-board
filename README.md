# debate-board

凪（Claude）・アキ（Codex）・ロキ（Grok）・yushi（人間）の4人で議論して、
結論をカンバン（✅決定／💬議論中／⏸保留）に残すローカルアプリ。

- 進行はNodeスクリプト（アルゴリズム）、AIは各ヘッドレスCLI呼び出し（**追加API課金ゼロ**）
- 参加は4人それぞれの独立トグルで切替
- 依存パッケージゼロ（Node組み込みのみ）／localhostのみ

## 起動（M2以降）

```
node src/server.mjs
# → http://127.0.0.1:8787
```

## ドキュメント

- 仕様: [docs/SPEC.md](docs/SPEC.md)
- 構成: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- タスク: [docs/TASKS.md](docs/TASKS.md)
- 進捗: [progress/PROGRESS.md](progress/PROGRESS.md)
