# Tasks

## 0. 前提

- [x] 0.1 方針は人が決めている（#31 のコメント、2026-11-06）。verify 0.35.0 にまとめる 3 件の 3 件目。ブランチは `fix/verify-0350`。`POL-REVIEW-SIGNATURES-NOT-READ` を足すことと PDF/UA を対象外にすることは、提案の「人が判断すること」で確かめてもらう

## 1. 受入テスト（先に落ちることを確かめる）

- [x] 1.1 `tests/unit/unauthenticated-encrypted.test.ts` を足す。検体は qpdf で `--encrypt secret owner 256` を掛ける（qpdf が無ければ飛ばす。CI は qpdf を入れている）。名前を「SPEC-VERIFY-<機能>-<3 桁> <Scenario 名>」で始める。ツールは McpServer に登録した実物を in-memory の transport で呼ぶ
- [x] 1.2 既存の 010 のテスト（`validate-conformance-encrypted-pdfa.test.ts`）の native の Scenario 名を、MODIFIED の名前に合わせる（期待は変えない）
- [x] 1.3 変更前の `src/` で 1.1 が落ちることを確かめる

## 2. 実装

- [x] 2.1 `src/utils/error-handler.ts`: `PdfVerifyError` と本文に `next_actions` を足す
- [x] 2.2 `src/services/conformance-validation.ts`: PDF/A の経路で、鍵を導けず `password` が無いときに `ENCRYPTED_PDF` を投げる（flavour の既定の注記より前）。`password` が違うときは `WRONG_PASSWORD`
- [x] 2.3 `verify_signatures`: 鍵を導けないときは `signatures: null` と `note`。markdown も直す
- [x] 2.4 `evaluate_policy`・`policy-engine.ts`: `signaturesObserved` を事実に足し、`POL-CAUTION-UNSIGNED`・`POL-REVIEW-UNSIGNED-REQUIRED` をそれで絞り、`POL-REVIEW-SIGNATURES-NOT-READ` を足す。`facts` を `null` と `note` にする
- [x] 2.5 `verify_integrity`: 鍵を導けないときは `signatureCount`・`documentTimestampCount` を `null`
- [x] 2.6 ツールの説明に書く。CI の一覧が終了コード 0

## 3. 確認

- [x] 3.1 `tools/list` の差がツールの説明の文だけであることを確かめる
- [ ] 3.2 pdf-agent-stack の S6 に、鍵を導けない文書の `validate_conformance` が `ENCRYPTED_PDF` になる件を足すかを、公開の後に決める

## 4. 承認と取り込み（人が判断する）

- [x] 4.1 人が `proposal.md` の front matter に `approved: YYYY-MM-DD` と `pr: N` を書く
- [x] 4.2 `signature-count-and-file-path` を先に archive し、そのあと同じ PR の中で `npx openspec archive unauthenticated-encrypted-document --yes` を実行する
- [x] 4.3 archive の後、正本 `openspec/specs/evaluate-policy/spec.md`・`openspec/specs/verify-signatures/spec.md` の先頭に front matter（`spec_id: VERIFY`・`kind: tool`・`introduced_by: unauthenticated-encrypted-document`）と Purpose（50 文字以上）を書き足す
- [x] 4.4 `npx openspec validate --all && npx spec-ids check` が通る
