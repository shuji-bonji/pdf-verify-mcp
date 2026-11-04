# record: family-error-contract

PDF family の OpenSpec + spec-ids 導入（pdf-agent-stack `docs/specs/31`）のもとでの、pdf-verify-mcp の 2 件目の記録です。書式は計画 §8 です。時刻は JST です。

| 項目 | 記録 |
| --- | --- |
| 版 | OpenSpec 1.14.1 / spec-ids 0.5.0 / pdf-verify-mcp 0.32.2 → 0.33.0（人が決めた。旧名を外すのは 0.34.0）/ Claude（claude.ai、モデル claude-opus-5-5）/ 2026-11-04 |
| きっかけ | pdf-agent-stack#48 で family のエラー応答の規約（`docs/specs/06` §2.3）を平らな形に書き直し、S6 の契約テストで verify が 5 件中 4 件落ちた。Issue は #35（形と語彙）と #32（`validate_clauses` の存在しないパス） |
| PR の切り方 | 1 本（計画 §6.3）。ブランチ `fix/family-error-contract`。提案の commit の後、人がチャットで承認し（23:46 ごろ）、同じブランチで実装した。`approved`・`pr` の記入と archive は PR を出した後に行う |
| 仕様を書いた時間 | 約 25 分（Issue と規約・S6・前例の読み込み込み） |
| 実装した時間 | 約 15 分（23:47 に着手し、受入テスト・実装・ゲート・S6・CHANGELOG・README までそろえた） |
| 人が判断した箇所 | (1) 提案の承認。(2) `retryable` の値（design.md の表のとおり）。(3) 版（0.33.0。旧名を外すのは 0.34.0）。(4) 先に pdf-trust Skill を直す順番（#48 の決定。pdf-trust-skill 0.8.4 で済ませた） |
| 仕様と実装のずれ | 0 件。実装中に 004 へ Scenario「7 ツールとも存在しないパスは DOC_NOT_FOUND」を 1 つ足した（テストを 7 ツール分に広げたときに、名前の付く Scenario が無かったため）。承認の後の追加なので、人が読み返す対象 |
| エージェントが仕様に無い振る舞いを実装した件数 | 0 件 |
| 実装後に仕様を読み返した回数 | 1 回（上の Scenario の追加） |
| テスト | `npm test` 266 → 291 件。受入テスト 25 件（`tests/unit/error-contract.test.ts`）は変更前の `src/` で 25 件とも落ち、変更後に通った。既存の 1 件（`document-scope.test.ts`）を 003 の Scenario の名前に書き換え、`code` と `hint` を新しい名前で見るようにした（意味は変えていない）。Node 22 と Node 20 の両方で 291 件。check:engines・check・typecheck・build・check:public-types は終了コード 0 |
| tools/list の比較 | 変更前（`36999fa`）と変更後の `dist` を stdio で起動して比べた。7 ツールとも同じ |
| S6（pdf-agent-stack `eval/e2e`） | verify は公開版 0.32.2 で 5 件中 1 件、このブランチ（`PDF_E2E_VERIFY_DIR`）で 5 件とも通った。同じ走りで spec（公開版 0.11.0）の 2 件も通った（#48 の時点では VM で起動できず未測定だった） |
| 維持の手間 | 仕様だけを変えた変更: 0 件 |

## 分かったこと

1. **名前の変わらないコードにも旧名の印が要った。** S6 は `detail.legacyCode` があるときだけ最上位の `message`・`suggestion` を認める。名前の変わらない `VERAPDF_NOT_FOUND` などにも `message` を残すので、移行の版のあいだはすべてのエラーに `legacyCode` を付けた（design.md の「旧名の付け方」）。
2. **#32 は「拒否の作り方を 1 つに寄せた」ことの副作用だった。** `validate_clauses` は、開く段の拒否を `toStructuralRefusal` に通すようにしたとき（ua-broken-startxref.pdf の件）、`readFile` の `ENOENT` も同じ catch に入るようになっていた。パスの検査を catch より前に置いた。
3. **成功時の出力は golden A/B で確かめていない。** 変えたのはエラーの本文と `validate_clauses` の入口だけなので省いた。コーパスはお手元にある。
