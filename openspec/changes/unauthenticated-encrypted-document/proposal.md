---
approved:
pr:
implementation: required
targets: [validate-conformance, evaluate-policy, verify-signatures, common-output, common-errors]
---

# Proposal

## Why

利用者パスワード付きの暗号化 PDF（空のパスワードでは鍵を導けない文書）に対して、verify はオブジェクトを 1 つも読めていません（`scope.authenticated: false`）。それなのに、読めなかったものを「無い」と数えています（#31・F-02・F-03）。`qpdf --encrypt secret owner 256` で暗号化した `smoke.pdf` の 0.32.2 の応答:

| ツール | 応答 |
| --- | --- |
| `validate_conformance`（native、または veraPDF の無い環境の `auto`） | 「XMP に pdfaid が無い」「OutputIntent が無い」を違反とし、残り 10 規則を通過に数える。鍵を導ける検体と 1 文字も違わない |
| `validate_conformance`（veraPDF のある環境の `auto`） | `ENCRYPTED_PDF` のエラー |
| `evaluate_policy` | `POL-CAUTION-UNSIGNED`（「No signatures」）を発火し、`facts.signatureCount: 0` |
| `verify_signatures` | `signatures: []` だけを返し、探せなかったことを書かない |

pdf-reader-mcp の `inspect_signatures` は、同じ文書に「This is not a document without signatures」と返しています（pdf-reader-mcp#39 の形）。

`evaluate_policy` と `verify_signatures` の仕様はまだありません。この変更で 2 つの capability の初版を起こし、鍵を導けない文書の扱いだけを書きます。

## What Changes

- `validate_conformance`: PDF/A の判定で、鍵を導けない暗号化文書に `password` が無いときは、**エンジンにかかわらず** `ENCRYPTED_PDF`（`retryable: true`）を返す。`next_actions` で `password` を付けて呼び直すことを案内する。`password` を渡して鍵を導けたときは従来どおり判定する。
- `common-errors`: エラーの本文に任意の `next_actions`（`action`・`reason`・`example`。pdf-agent-stack `docs/specs/06` §2.3）を置けるようにする。付けるのは上の `ENCRYPTED_PDF` だけ。
- `verify_signatures`: 鍵を導けないときは、成功の応答のまま `signatures` を `[]` ではなく `null` にし、`note` に理由を書く。
- `evaluate_policy`: 鍵を導けないときは、`facts.signatures` を `null`、`facts.signatureCount`・`facts.documentTimestampCount` を `null` にし、`facts.note` に理由を書く。`POL-CAUTION-UNSIGNED`・`POL-REVIEW-UNSIGNED-REQUIRED` は署名が無いと観測できたときだけ発火させ、探せなかったときは新しい規則 `POL-REVIEW-SIGNATURES-NOT-READ`（`human_review_required`）を発火させる。
- `verify_integrity`: 鍵を導けないときは、`signatureCount`・`documentTimestampCount` を `null` にする（`common-output` の 003）。

### 変わる振る舞い

- 鍵を導けない暗号化文書に対する上の 4 ツールの応答。`validate_conformance`（PDF/A）は違反の一覧からエラーに、`evaluate_policy` の `verdict` は `use_with_caution` から `human_review_required` に変わる。
- 型 `SignatureVerificationResult.signatures` と `IntegrityReport.signatureCount`・`documentTimestampCount` が `null` を取りうるようになる。

### 変わらない振る舞い

- 暗号化されていない文書と、空の利用者パスワードで鍵を導ける文書の応答。鍵を導ける暗号化文書の native の PDF/A 判定は今までどおり `no-encryption` の違反を返す（SPEC-VERIFY-VALIDATE-CONFORMANCE-010）。
- 鍵を導ける暗号化文書を veraPDF に渡さないこと（010）。
- PDF/UA の判定。鍵を導けない文書は今までどおり、構造の規則を「見ていない」と報告し、`ua-no-encryption-barrier` だけを判定する（SPEC-VERIFY-VALIDATE-CONFORMANCE-008）。この規則は暗号化辞書だけで判定できるので、判定に使い道があるため。

### 対象外

- `detect_pades_level` の `levels` を `null` にすること。
- `validate_clauses`・`identify_conformance` の、鍵を導けない文書の扱い。
- pdf-publish Skill の Phase 3 の記述（verify の公開の後に PR で直す）。

## Capabilities

- `validate-conformance`（MODIFIED: 010。ADDED: 016）
- `common-errors`（MODIFIED: 001）
- `evaluate-policy`（新規。`kind: tool`。ADDED: 001・002）
- `verify-signatures`（新規。`kind: tool`。ADDED: 001）
- `common-output`（ADDED: 003。`signature-count-and-file-path` の変更が作る capability なので、その変更を先に archive する）

起こす範囲は、鍵を導けない文書の扱いだけです。`evaluate_policy` の規則の全体と `verify_signatures` の検証の中身は既存のテスト（`tests/unit/evaluate-policy.test.ts`・`verify-signatures.test.ts`）が固定していて、この変更では起こしません。

## 人が判断すること

- 🔴 **新しい規則 `POL-REVIEW-SIGNATURES-NOT-READ` を足すこと。** 2026-11-06 の決定は「`POL-CAUTION-UNSIGNED` は観測できたときだけ」でした。そのまま外すと、ほかの規則が何も発火せず `verdict` が `trust_and_use` になります（RULES の冒頭のコメント「証拠が欠けたら caution の規則のどれかが発火する」が崩れる）。署名があるかどうか、あったとして有効かどうかが分からないので、`use_with_caution` ではなく `human_review_required` を提案します。
- PDF/UA の判定はエラーにしないこと（上の「変わらない振る舞い」）。決定は「`validate_conformance` は」と書いていますが、PDF/UA の経路には暗号化辞書だけで判定できる規則があるので、この変更では PDF/A に限りました。
- `next_actions` の `action` の値を `validate_conformance`（呼び直すツールの名前）にし、`example` に `password` を入れること。`action` は Skill が分岐に使う値になります。
- `verify_integrity` の数も `null` にすること（決定は `evaluate_policy`・`verify_signatures` を挙げていました。#34 で `signatureCount` を全ツールでそろえるので、同じ扱いにしました）。
