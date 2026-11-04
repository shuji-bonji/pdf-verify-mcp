# Tasks

## 0. 前提

- [x] 0.1 人が proposal.md を承認している（1 本の PR で提案・仕様・実装・archive を進める。ブランチは `fix/family-error-contract`）

## 1. 受入テスト（先に落ちることを確かめる）

- [x] 1.1 `tests/unit/error-contract.test.ts` を足す。各 Scenario を 1 件以上のテストにし、名前を「SPEC-VERIFY-COMMON-ERRORS-<3 桁> <Scenario 名>」で始める。ツールは McpServer に登録した実物を in-memory の transport で呼び、本文の JSON を見る
- [x] 1.2 既存の `tests/unit/document-scope.test.ts` の「PARSE_FAILED であって INTERNAL_ERROR ではない」を 003 の「組み直す材料の無い文書は INVALID_PDF」に書き換える（`code` と `hint` を新しい名前で見る。期待の意味は変えない）
- [x] 1.3 変更前の `src/` で 1.1 が落ちることを確かめる

## 2. 実装

- [x] 2.1 `src/utils/error-handler.ts`: `PdfVerifyError` の `code` を新しい名前にし、`hint`・`reason`・`legacyCode` を持たせる。`retryable` は code ごとの表から引く。`handleStructuredError` が design.md の形を組む
- [x] 2.2 エラーを作る箇所（`assertReadablePdf`・`toStructuralRefusal`・`conformance-validation.ts` の `INVALID_FLAVOUR` 2 か所）を新しい名前にする
- [x] 2.3 `src/services/clause-validation.ts` の `validateClauses` の先頭で `assertReadablePdf` を呼ぶ（#32）
- [x] 2.4 `npm run check:engines`・`npm run check`・`npm run typecheck`・`npm test`・`npm run build`・`npm run check:public-types` が終了コード 0

## 3. 出力が変わらないことの確認

- [x] 3.1 変更前と変更後の `dist` を起動し、`tools/list` の差が無いことを確かめる
- [x] 3.2 pdf-agent-stack の `eval/e2e` の S6 を `PDF_E2E_VERIFY_DIR` で手元のビルドに向けて回し、verify の 4 件と宣言に無いキーの 1 件が通ることを確かめる

## 4. 版と記録

- [x] 4.1 `CHANGELOG.md`（英語）の `[Unreleased]` に書く。版は人が決める
- [x] 4.2 `README.md` と `README.ja.md`、`docs/` にエラーの形と旧コードの記述があれば両方を直す
- [x] 4.3 `record.md` を計画 §8 の書式で書く

## 5. 承認と取り込み（人が判断する）

- [x] 5.1 人が `proposal.md` の front matter に `approved: YYYY-MM-DD` と `pr: N` を書く
- [x] 5.2 マージの前に、同じ PR の中で `npx openspec archive family-error-contract --yes` を実行する
- [x] 5.3 archive の後、正本 `openspec/specs/common-errors/spec.md` の先頭に front matter（`spec_id: VERIFY`・`kind: common`・`introduced_by: family-error-contract`）と Purpose（50 文字以上）を書き足す（OpenSpec 1.14.1 は差分の front matter を写さない）
- [x] 5.4 `npx openspec validate --all && npx spec-ids check` が通る
