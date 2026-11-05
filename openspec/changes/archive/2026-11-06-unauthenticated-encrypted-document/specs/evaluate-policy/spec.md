## ADDED Requirements

### Requirement: SPEC-VERIFY-EVALUATE-POLICY-001 鍵を導けない文書では、署名を探せなかったことを null と note で示す

文書が暗号化されていて鍵を導けない（`scope.authenticated: false`）ときは、成功の応答のまま、`facts.signatures`・`facts.signatureCount`・`facts.documentTimestampCount` を `[]` や `0` ではなく `null` にし、`facts.note` に「鍵を導けないので署名フィールドを探せなかった。署名の無い文書ではない」という趣旨の英語の文を書く（SHALL）。根拠は ISO 32000-2 §7.6.4.3.2（鍵の導出）と、pdf-reader-mcp の `inspect_signatures` が同じ文書に返す形。

#### Scenario: 利用者パスワード付きの文書
- **WHEN** 利用者パスワード付きの暗号化文書を `password` なしで `profile: "general"` で評価する
- **THEN** `facts.signatures` は `null`、`facts.signatureCount` は `null`、`facts.note` が空でない文字列

#### Scenario: password を渡せば数える
- **WHEN** 同じ文書を正しい `password` で評価する
- **THEN** `facts.signatureCount` は数（`0` 以上の整数）で、`facts.note` が無い

### Requirement: SPEC-VERIFY-EVALUATE-POLICY-002 署名が無いという規則は、無いと観測できたときだけ発火させる

`POL-CAUTION-UNSIGNED` と `POL-REVIEW-UNSIGNED-REQUIRED` は、署名フィールドを探して 1 つも無いと観測できたときだけ発火させる（SHALL）。署名を探せなかったときは、代わりに `POL-REVIEW-SIGNATURES-NOT-READ`（`human_review_required`）を発火させる（SHALL）。読めなかった文書の `verdict` を `trust_and_use` にしない（SHALL）。

#### Scenario: 探せなかった文書に No signatures を言わない
- **WHEN** 利用者パスワード付きの暗号化文書を `password` なしで `profile: "general"` で評価する
- **THEN** `firedRules` に `POL-CAUTION-UNSIGNED` が無く、`POL-REVIEW-SIGNATURES-NOT-READ` があり、`verdict` は `human_review_required`

#### Scenario: 署名を要する profile でも同じ
- **WHEN** 同じ文書を `profile: "contract"` で評価する
- **THEN** `firedRules` に `POL-REVIEW-UNSIGNED-REQUIRED` が無く、`POL-REVIEW-SIGNATURES-NOT-READ` がある

#### Scenario: 読めた無署名の文書は今までどおり
- **WHEN** 暗号化されていない無署名の文書を `profile: "general"` で評価する
- **THEN** `firedRules` に `POL-CAUTION-UNSIGNED` があり、`POL-REVIEW-SIGNATURES-NOT-READ` が無い
