## MODIFIED Requirements

### Requirement: SPEC-VERIFY-COMMON-ERRORS-001 エラー応答の本文は family の平らな形にする

7 ツールのハンドラが返す失敗は、ツール結果の `isError: true` で返し、`content` の text を JSON のオブジェクトにする（SHALL）。最上位には `error`（英語の 1 文。空でない文字列）・`code`（文字列）・`retryable`（真偽値）を必ず書き、任意で `hint`（英語の文字列）と `detail`（オブジェクト）を書く（SHALL）。最上位にこれ以外の項目を置かない（SHALL）。0.33.x が移行のために置いていた `message`・`suggestion` と `detail.legacyCode` は置かない（SHALL）。根拠は pdf-agent-stack `docs/specs/06` §2.3。

#### Scenario: 存在しないパスのエラーが形どおり

- **WHEN** `identify_conformance` に存在しない絶対パスを渡す
- **THEN** `isError` が `true` で、本文の `error` は空でない文字列、`retryable` は真偽値、最上位の項目は `error`・`code`・`retryable`・`hint`・`detail` のどれか

#### Scenario: 故障のエラーも形どおり

- **WHEN** ハンドラの中で `PdfVerifyError` でない例外が投げられる
- **THEN** `code` は `INTERNAL_ERROR`、`error` は例外の文、`retryable` は `false`

#### Scenario: 移行の版の旧い名前を返さない

- **WHEN** 存在しないパス・PDF でないファイル・相対パスをそれぞれ渡す
- **THEN** どの本文にも `message`・`suggestion` が無く、`detail` があっても `legacyCode` が無い

## REMOVED Requirements

### Requirement: SPEC-VERIFY-COMMON-ERRORS-006 移行の版のあいだは旧い名前も返す

**Reason**: 移行の版（0.33.x）のためだけの要求で、0.34.0 で外すと 2026-11-04 に決めていた。受け側の Skill（pdf-trust v0.8.4・pdf-publish v0.7.2）は新しい名前を読む。

**Migration**: `message` の代わりに `error`、`suggestion` の代わりに `hint`、`detail.legacyCode` の代わりに `code`（`INVALID_ARGUMENT` の細かい理由は `detail.reason`）を読む。旧名と新しい名前の対応は `FILE_NOT_FOUND` → `DOC_NOT_FOUND`、`PARSE_FAILED` → `INVALID_PDF`、`MISSING_PATH`・`RELATIVE_PATH`・`NOT_A_FILE`・`INVALID_FLAVOUR` → `INVALID_ARGUMENT`（`detail.reason` に同じ名前）。
