## MODIFIED Requirements

### Requirement: SPEC-VERIFY-COMMON-ERRORS-001 エラー応答の本文は family の平らな形にする

7 ツールのハンドラが返す失敗は、ツール結果の `isError: true` で返し、`content` の text を JSON のオブジェクトにする（SHALL）。最上位には `error`（英語の 1 文。空でない文字列）・`code`（文字列）・`retryable`（真偽値）を必ず書き、任意で `hint`（英語の文字列）・`next_actions`（`action`・`reason`・任意の `example` を持つオブジェクトの配列）・`detail`（オブジェクト）を書く（SHALL）。最上位にこれ以外の項目を置かない（SHALL）。0.33.x が移行のために置いていた `message`・`suggestion` と `detail.legacyCode` は置かない（SHALL）。根拠は pdf-agent-stack `docs/specs/06` §2.3。

#### Scenario: 存在しないパスのエラーが形どおり

- **WHEN** `identify_conformance` に存在しない絶対パスを渡す
- **THEN** `isError` が `true` で、本文の `error` は空でない文字列、`retryable` は真偽値、最上位の項目は `error`・`code`・`retryable`・`hint`・`next_actions`・`detail` のどれか

#### Scenario: 故障のエラーも形どおり

- **WHEN** ハンドラの中で `PdfVerifyError` でない例外が投げられる
- **THEN** `code` は `INTERNAL_ERROR`、`error` は例外の文、`retryable` は `false`

#### Scenario: 移行の版の旧い名前を返さない

- **WHEN** 存在しないパス・PDF でないファイル・相対パスをそれぞれ渡す
- **THEN** どの本文にも `message`・`suggestion` が無く、`detail` があっても `legacyCode` が無い
