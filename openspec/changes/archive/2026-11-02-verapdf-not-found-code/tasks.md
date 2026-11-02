# Tasks

## 0. 前提

- [x] 0.1 この仕様 PR（`spec/verapdf-not-found-code`、#28）がマージされている。実装は別の PR（`fix/verapdf-not-found-code`）で行う（実装は #28 の承認の commit の上で進め、マージは人が確かめる）

## 1. 受入テスト（先に落ちることを確かめる）

- [x] 1.1 `tests/unit/validate-conformance.test.ts` の `describe('veraPDF engine selection')` のテストを書き換え、先頭の `return` をやめる。`PDF_VERIFY_VERAPDF` を消し、`PATH` を空のフォルダーにし、`setWellKnownPathsForTesting([])` で決まった場所を外したうえで、`engine: "verapdf"` の判定が `code: "VERAPDF_NOT_FOUND"` のエラーになることを確かめる。名前は「SPEC-VERIFY-VALIDATE-CONFORMANCE-013 どこにも入っていない」で始める
- [x] 1.2 同じ `describe` に、同じ条件で `resolveVeraPdf()` が `{ available: false, reason: "not_installed" }` を返すテストを足す（012 の対。名前は SPEC-VERIFY-VALIDATE-CONFORMANCE-013 で始める）
- [x] 1.3 `tests/unit/registry.test.ts` に、`tools/list` の `validate_conformance` の説明が `VERAPDF_NOT_AVAILABLE` と `VERAPDF_NOT_FOUND` を含むテストを足す。名前は「SPEC-VERIFY-VALIDATE-CONFORMANCE-013 説明に 2 つの code が出る」で始める
- [x] 1.4 変更前の `src/` で、1.1〜1.3 が落ちることを確かめる（1.1・1.2 は `setWellKnownPathsForTesting` が無いため、1.3 は説明に `VERAPDF_NOT_FOUND` が無いため）。テストの後片付け（環境変数・`PATH`・候補を戻す）が、落ちたときも走ることを確かめる

## 2. 実装

- [x] 2.1 `src/services/verapdf.ts` に `setWellKnownPathsForTesting` を足し、`lookUpVeraPdf` が `WELL_KNOWN_PATHS` の代わりに差し替え可能な候補を見るようにする（design.md の「差し替えの入口」）
- [x] 2.2 `src/tools/validate-conformance.ts` の description に、`not_installed` のとき `engine: "verapdf"` が `VERAPDF_NOT_FOUND` で失敗することを書く
- [x] 2.3 `npm run check:engines`・`npm run check`・`npm run typecheck`・`npm test`・`npm run build`・`npm run check:public-types` が終了コード 0

## 3. 出力が変わらないことの確認

- [x] 3.1 変更前と変更後の `dist` を起動し、`tools/list` の差が `validate_conformance` の description だけであることを確かめる
- [ ] 3.2 veraPDF のある手元の Mac で `npm test` を回し、1.1 が `return` せずに通ることを確かめる（作業環境には veraPDF が無いので、手元で確かめる）

## 4. 版と記録

- [x] 4.1 `CHANGELOG.md`（英語）の `[Unreleased]` に書く。版は人が決める
- [x] 4.2 `README.md` と `README.ja.md` にエラーの `code` の記載があれば、両方に `VERAPDF_NOT_FOUND` を書く（どちらにも `code` の記載は無かったので、変更なし）
- [x] 4.3 `record.md` を計画 §8 の書式で書き足す

## 5. 承認と取り込み（人が判断する）

- [x] 5.1 人が `proposal.md` の front matter に `approved: YYYY-MM-DD` と `pr: N` を書く（この仕様 PR の番号）
- [x] 5.2 実装 PR のマージの前に、同じ実装 PR の中で `npx openspec archive verapdf-not-found-code --yes` を実行し、013 を正本に取り込む
- [x] 5.3 `npx openspec validate --all && npx spec-ids check` が通る
