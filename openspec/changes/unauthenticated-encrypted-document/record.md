# record: unauthenticated-encrypted-document

PDF family の OpenSpec + spec-ids 導入（pdf-agent-stack `docs/specs/31`）のもとでの記録です。書式は計画 §8 です。時刻は JST です。

| 項目 | 記録 |
| --- | --- |
| きっかけ | pdf-agent-stack#47 の試用の所見（#31・F-02・F-03） |
| 版 | OpenSpec 1.14.1 / spec-ids 0.5.0 / pdf-verify-mcp 0.34.0 → 0.35.0（提案。人が決める）/ Claude（claude.ai、モデル claude-opus-5-5）/ 2026-11-06 |
| PR の切り方 | verify 0.35.0 の 3 件（#33・#34・#31）を 1 本のブランチ `fix/verify-0350` にまとめた。変更ごとに test → fix/feat の commit。提案は人の決定（各 Issue のコメント、2026-11-06 01:01）の後に書き、チャットでの承認を待たずに実装した（引き継ぎの「進め方」）。`approved`・`pr` の記入と archive は PR の後 |
| tools/list の比較 | 変更前（main の `be531f3`）と変更後の `dist` を `pdf-agent-stack/scripts/tools-list-snapshot.mjs` で比べた。7 ツールとも description が伸び、`validate_conformance` の inputSchema は `password` の説明文だけが変わった。ツール数・required・additionalProperties は同じ |
| ゲート | check:engines・check・typecheck・test（Node 22 と Node 20.20.2 で 317 件）・build・check:public-types が終了コード 0 |
| 維持の手間 | 仕様だけを変えた変更: 0 件 |
| 仕様を書いた時間 | 約 10 分（policy-engine の規則の一覧を読み、`POL-CAUTION-UNSIGNED` を外すだけでは `trust_and_use` になることに気づいた） |
| 実装した時間 | 約 10 分 |
| 人が判断した箇所 | (1) 方針（#31 のコメント）。(2) 🔴 新しい規則 `POL-REVIEW-SIGNATURES-NOT-READ` を足すこと、PDF/UA を対象外にすること、`verify_integrity` の数も `null` にすること、`next_actions` の値（提案の「人が判断すること」。未確認） |
| 仕様と実装のずれ | 0 件 |
| エージェントが仕様に無い振る舞いを実装した件数 | 0 件（上の 4 点は提案に書いてから実装した） |
| テスト | `tests/unit/unauthenticated-encrypted.test.ts` 12 件（qpdf で `--encrypt secret owner 256`）。変更前の `src/` で 8 件が落ち、変わらない振る舞いの 4 件は前から通る。既存の `error-contract.test.ts` の最上位の項目の一覧に `next_actions` を足した（MODIFIED 001） |
| archive の順 | `common-output` は `signature-count-and-file-path` が作るので、そちらを先に archive する |
