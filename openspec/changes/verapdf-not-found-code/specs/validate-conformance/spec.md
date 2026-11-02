## MODIFIED Requirements

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-013 engine に verapdf を求められて使えなければ、エラーにする

`engine: "verapdf"` を渡されたのに veraPDF を使えないときは、native エンジンで代えずにエラーにする（SHALL）。エラーの `code` は使えない理由で分け、`PDF_VERIFY_VERAPDF` が実行できないパスを指しているときは `VERAPDF_NOT_AVAILABLE`、環境変数・PATH・決まった場所のどこにも veraPDF が無いときは `VERAPDF_NOT_FOUND` にする（SHALL）。返しうる 2 つの `code` は、`tools/list` の `validate_conformance` の説明にも書く（SHALL）。

#### Scenario: 設定したパスが使えない
- **WHEN** `PDF_VERIFY_VERAPDF` が存在しないパスを指す状態で `engine: "verapdf"` で判定する
- **THEN** `code: "VERAPDF_NOT_AVAILABLE"` のエラーになる

#### Scenario: どこにも入っていない
- **WHEN** `PDF_VERIFY_VERAPDF` が無く、PATH にも決まった場所にも veraPDF が無い状態で `engine: "verapdf"` で判定する
- **THEN** `code: "VERAPDF_NOT_FOUND"` のエラーになる

#### Scenario: 説明に 2 つの code が出る
- **WHEN** `tools/list` で `validate_conformance` の説明を読む
- **THEN** `VERAPDF_NOT_AVAILABLE` と `VERAPDF_NOT_FOUND` の両方が出る
