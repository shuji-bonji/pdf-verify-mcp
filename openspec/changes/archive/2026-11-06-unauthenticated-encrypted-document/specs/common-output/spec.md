## ADDED Requirements

### Requirement: SPEC-VERIFY-COMMON-OUTPUT-003 鍵を導けない文書では、署名の数を null にする

文書が暗号化されていて鍵を導けない（`scope.authenticated: false`）ときは、`signatureCount` と `documentTimestampCount` を `0` ではなく `null` にする（SHALL）。署名を探せなかったことと、署名が 0 本であることを同じ値で返さないためである。対象は `verify_integrity` の最上位と `evaluate_policy` の `facts`。

#### Scenario: verify_integrity の数
- **WHEN** 利用者パスワード付きの暗号化文書を `verify_integrity` に渡す
- **THEN** `signatureCount` は `null`、`documentTimestampCount` は `null`
