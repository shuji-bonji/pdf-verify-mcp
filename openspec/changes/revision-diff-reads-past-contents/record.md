# record: revision-diff-reads-past-contents

PDF family の OpenSpec + spec-ids 導入（pdf-agent-stack `docs/specs/31`）のもとでの記録です。書式は計画 §8 です。時刻は JST です。

| 項目 | 記録 |
| --- | --- |
| きっかけ | pdf-agent-stack#47 の試用の所見（#33・F-24） |
| 版 | OpenSpec 1.14.1 / spec-ids 0.5.0 / pdf-verify-mcp 0.34.0 → 0.35.0（提案。人が決める）/ Claude（claude.ai、モデル claude-opus-5-5）/ 2026-11-06 |
| PR の切り方 | verify 0.35.0 の 3 件（#33・#34・#31）を 1 本のブランチ `fix/verify-0350` にまとめた。変更ごとに test → fix/feat の commit。提案は人の決定（各 Issue のコメント、2026-11-06 01:01）の後に書き、チャットでの承認を待たずに実装した（引き継ぎの「進め方」）。`approved`・`pr` の記入と archive は PR の後 |
| tools/list の比較 | 変更前（main の `be531f3`）と変更後の `dist` を `pdf-agent-stack/scripts/tools-list-snapshot.mjs` で比べた。7 ツールとも description が伸び、`validate_conformance` の inputSchema は `password` の説明文だけが変わった。ツール数・required・additionalProperties は同じ |
| ゲート | check:engines・check・typecheck・test（Node 22 と Node 20.20.2 で 317 件）・build・check:public-types が終了コード 0 |
| 維持の手間 | 仕様だけを変えた変更: 0 件 |
| 仕様を書いた時間 | 約 5 分（ISO 32000-2 Table 255 を pdf-spec-mcp で確かめた: `Type` は Sig で Optional・既定値 Sig、DocTimeStamp で Required。`Filter`・`Contents` は Required、`ByteRange` は署名フィールドで Required） |
| 実装した時間 | 約 5 分 |
| 人が判断した箇所 | (1) 方針（#33 のコメント）。(2) 走査の上限 1 MiB と、untyped の署名の辞書の条件（提案の「人が判断すること」。未確認） |
| 仕様と実装のずれ | 0 件。受入テストに Scenario 外の 1 件（リテラル文字列の中の `>>` と `/Type` で迷わない）を 001 の名前で足した |
| テスト | `tests/unit/revision-diff-typing.test.ts` 6 件。変更前の `src/` で 5 件が落ち、変更後に通った（ByteRange の無い辞書を署名と見なさない件は前から通る） |
| 実検体 | pdf-agent-stack `eval/hosts/grok-build/fixtures/incoming/contract-like-signed.pdf` のオブジェクト 27・36 が、変更前 `null / null / unknown`、変更後 `Sig / signature dictionary / signature`・`DocTimeStamp / document timestamp / signature` |
