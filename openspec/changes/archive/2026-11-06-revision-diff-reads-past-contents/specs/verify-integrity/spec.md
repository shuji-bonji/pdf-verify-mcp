## ADDED Requirements

### Requirement: SPEC-VERIFY-VERIFY-INTEGRITY-001 リビジョン差分は、キーの順序と文字列の長さにかかわらず辞書の /Type を読む

リビジョン差分で変わったオブジェクトの `/Type`・`/Subtype` とキーを読むとき、16 進文字列とリテラル文字列は閉じる記号まで読み飛ばし、辞書が閉じるまで読む（SHALL）。`/Contents` のような長い文字列が `/Type` より前にあっても、`/Type` を読めなかったことにしない（SHALL）。辞書のキーの順序は ISO 32000-2 §7.3.7 で決まっていないので、どの順序の文書にも同じ答えを返す。閉じない辞書に備えて 1 オブジェクトあたりの走査に上限（1 MiB）を置き、上限までに読めたキーで見分ける（SHALL）。

#### Scenario: Contents の後ろに Type がある署名の辞書

- **WHEN** 増分更新が、`/Contents` の 16 進文字列（10,000 文字）を `/Type /Sig` より前に置いた署名の辞書を足す
- **THEN** その変更の `type` は `Sig`、`role` は `signature dictionary`、`changeClass` は `signature`

#### Scenario: Contents の後ろに Type がある文書タイムスタンプの辞書

- **WHEN** 増分更新が、`/Contents` の 16 進文字列（10,000 文字）を `/Type /DocTimeStamp` より前に置いた辞書を足す
- **THEN** その変更の `type` は `DocTimeStamp`、`role` は `document timestamp`、`changeClass` は `signature`

#### Scenario: P=2 の文書に足した署名は許された変更になる

- **WHEN** DocMDP の P=2 で証明された文書に、`/Contents` を `/Type` より前に置いた署名の辞書を増分更新で足す
- **THEN** `certification.violationAssessment` は `permitted`（`indeterminate` ではない）

### Requirement: SPEC-VERIFY-VERIFY-INTEGRITY-002 /Type の無い署名の辞書を、Table 255 の必須の項目で見分ける

`/Type` を持たない辞書が `/Filter`・`/ByteRange`・`/Contents` の 3 つを持つときは、署名の辞書として `role` を `signature dictionary`、`changeClass` を `signature` にする（SHALL）。根拠は ISO 32000-2 §12.8.1 Table 255（署名の辞書の `Type` は Optional で既定値は `Sig`、`Filter`・`Contents` は Required、`ByteRange` は署名フィールドの署名で Required）。`type` は書かれていたとおり `null` で返す（SHALL）。3 つのどれかが欠けた untyped の辞書は、ほかのキーで見分けられなければ今までどおり `unknown` にする（SHALL）。

#### Scenario: Type の無い署名の辞書

- **WHEN** 増分更新が、`/Type` を持たず `/Filter`・`/ByteRange`・`/Contents` を持つ辞書を足す
- **THEN** その変更の `type` は `null`、`role` は `signature dictionary`、`changeClass` は `signature`

#### Scenario: ByteRange の無い untyped の辞書は署名と見なさない

- **WHEN** 増分更新が、`/Filter` と `/Contents` だけを持つ untyped の辞書を足す
- **THEN** その変更の `changeClass` は `unknown`
