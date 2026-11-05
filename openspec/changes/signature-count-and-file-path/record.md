# record: signature-count-and-file-path

PDF family の OpenSpec + spec-ids 導入（pdf-agent-stack `docs/specs/31`）のもとでの記録です。書式は計画 §8 です。時刻は JST です。

| 項目 | 記録 |
| --- | --- |
| きっかけ | pdf-agent-stack#47 の試用の所見（#34・F-17・F-29） |
| 版 | OpenSpec 1.14.1 / spec-ids 0.5.0 / pdf-verify-mcp 0.34.0 → 0.35.0（提案。人が決める）/ Claude（claude.ai、モデル claude-opus-5-5）/ 2026-11-06 |
| PR の切り方 | verify 0.35.0 の 3 件（#33・#34・#31）を 1 本のブランチ `fix/verify-0350` にまとめた。変更ごとに test → fix/feat の commit。提案は人の決定（各 Issue のコメント、2026-11-06 01:01）の後に書き、チャットでの承認を待たずに実装した（引き継ぎの「進め方」）。`approved`・`pr` の記入と archive は PR の後 |
| tools/list の比較 | 変更前（main の `be531f3`）と変更後の `dist` を `pdf-agent-stack/scripts/tools-list-snapshot.mjs` で比べた。7 ツールとも description が伸び、`validate_conformance` の inputSchema は `password` の説明文だけが変わった。ツール数・required・additionalProperties は同じ |
| ゲート | check:engines・check・typecheck・test（Node 22 と Node 20.20.2 で 317 件）・build・check:public-types が終了コード 0 |
| 維持の手間 | 仕様だけを変えた変更: 0 件 |
| 仕様を書いた時間 | 約 5 分 |
| 実装した時間 | 約 5 分 |
| 人が判断した箇所 | (1) 方針（#34 のコメント）。(2) `file_path` を JSON の最初に置くこと、エラーの本文には足さないこと（提案の「人が判断すること」。未確認） |
| 仕様と実装のずれ | 0 件 |
| テスト | `tests/unit/common-output.test.ts` 11 件（7 ツール × JSON、markdown、数 3 件）。変更前の `src/` で 11 件とも落ちた。検体の文書タイムスタンプの `/Contents` を 0 で埋めたら詰め物として切られて数えられなかったので、0 でない値に直した（落ちる理由が変わらないことを確かめた）。既存の `response-caps.test.ts` は `renderBody` の引数が増えた分だけ直した |
