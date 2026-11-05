## MODIFIED Requirements

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-010 暗号化された文書を veraPDF に渡さない

PDF/A の判定で veraPDF を使う場面で文書が暗号化されていたら、veraPDF を呼ぶ前に `ENCRYPTED_PDF` のエラーにし、`INTERNAL_ERROR` にしない（SHALL）。native エンジンでは、鍵を導けた暗号化文書について例外にせず、`no-encryption` の違反として報告する（SHALL）。鍵を導けない文書の扱いは SPEC-VERIFY-VALIDATE-CONFORMANCE-016 に従う。

#### Scenario: veraPDF を使う場面の暗号化文書
- **WHEN** veraPDF が使える状態で、暗号化された文書を `pdfa-3b`・`engine: "auto"` で判定する
- **THEN** `ENCRYPTED_PDF` のエラーになる

#### Scenario: native エンジンの暗号化文書
- **WHEN** 鍵を導けた暗号化文書を `pdfa-3b`・`engine: "native"` で判定する
- **THEN** `violations` に `no-encryption` があり、`compliant` は `false`

## ADDED Requirements

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-016 鍵を導けない暗号化文書の PDF/A 判定は、エンジンにかかわらず ENCRYPTED_PDF にする

PDF/A の判定で、文書が暗号化されていて空の利用者パスワードでは鍵を導けず（ISO 32000-2 §7.6.4.3.2）、`password` が渡されていないときは、`engine` の値と veraPDF の有無にかかわらず `ENCRYPTED_PDF` のエラーを返す（SHALL）。XMP・OutputIntent・フォントなどオブジェクトを読まないと判定できない規則を、違反にも通過にも数えない（SHALL）。エラーの本文の `next_actions` には、`password` を付けて `validate_conformance` を呼び直す案内を 1 つ置く（SHALL）。`password` を渡して鍵を導けたときは、従来どおり判定する（SHALL）。違う `password` のときは `WRONG_PASSWORD` にする（SHALL）。

#### Scenario: native エンジンでも ENCRYPTED_PDF
- **WHEN** 利用者パスワード付きの暗号化文書を、`password` なし・`flavour: "pdfa-2b"`・`engine: "native"` で判定する
- **THEN** `isError` は `true`、`code` は `ENCRYPTED_PDF`、`retryable` は `true`、`next_actions[0].action` は `validate_conformance`

#### Scenario: flavour を省いても ENCRYPTED_PDF
- **WHEN** 同じ文書を `flavour` と `password` を省いて判定する
- **THEN** `code` は `ENCRYPTED_PDF`（「Document declares no PDF/A identification」の注記を付けた違反の一覧を返さない）

#### Scenario: password を渡せば判定する
- **WHEN** 同じ文書を正しい `password` と `engine: "native"` で判定する
- **THEN** 成功の応答で、`scope.authenticated` は `true`、`violations` に `no-encryption` がある
