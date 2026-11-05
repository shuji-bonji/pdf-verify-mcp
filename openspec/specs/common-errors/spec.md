---
spec_id: VERIFY
kind: common
introduced_by: family-error-contract
---
# common-errors Specification

## Purpose

7 ツールに共通する、失敗の返し方を定めます。ツール結果 `isError: true` の本文の形（PDF family の規約 pdf-agent-stack `docs/specs/06` §2.3）、状況ごとの `code`（houki-hub family の共通語彙と verify 固有のコード）、`retryable` の値、パスの検査をどのツールも同じ順で通すこと、移行の版のあいだ旧い名前も返すことを扱います。
受け側の Skill（pdf-trust など）は `code` で分岐し、`INVALID_PDF` を「文書についての所見」、`DOC_NOT_FOUND`・`INVALID_ARGUMENT`・`INTERNAL_ERROR` を「判定できなかった」として扱います。SDK がハンドラより前に拒む入力検証の失敗は、この capability の対象外です（§2.11）。

## Requirements

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

### Requirement: SPEC-VERIFY-COMMON-ERRORS-002 同じ状況には family の共通語彙の code を返す

ファイルと引数の失敗には、houki-hub family の共通語彙の `code` を返す（SHALL）。渡したパスにファイルが無いときは `DOC_NOT_FOUND`、引数の誤り（パスが無い・相対パス・パスが通常のファイルでない・不正な flavour）は `INVALID_ARGUMENT` で、細かい理由を `detail.reason`（`MISSING_PATH`・`RELATIVE_PATH`・`NOT_A_FILE`・`INVALID_FLAVOUR`）に書く（SHALL）。サイズの上限を超えたときは `FILE_TOO_LARGE`、暗号化のため判定しないときは `ENCRYPTED_PDF` にする（SHALL）。サーバー固有のコードは `INVALID_BYTE_RANGE`・`WRONG_PASSWORD`・`VERAPDF_NOT_FOUND`・`VERAPDF_NOT_AVAILABLE`・`VERAPDF_NO_RESULT` だけで、共通語彙と同じ意味の別名を返さない（SHALL）。

#### Scenario: 存在しないパスは DOC_NOT_FOUND

- **WHEN** 存在しない絶対パスを渡す
- **THEN** `code` は `DOC_NOT_FOUND`

#### Scenario: 相対パスは INVALID_ARGUMENT

- **WHEN** 相対パスを渡す
- **THEN** `code` は `INVALID_ARGUMENT`、`detail.reason` は `RELATIVE_PATH`

#### Scenario: フォルダーは INVALID_ARGUMENT

- **WHEN** フォルダーの絶対パスを渡す
- **THEN** `code` は `INVALID_ARGUMENT`、`detail.reason` は `NOT_A_FILE`

#### Scenario: 不正な flavour は INVALID_ARGUMENT

- **WHEN** `validate_conformance` に `flavour: "pdfa-4b"` を渡す
- **THEN** `code` は `INVALID_ARGUMENT`、`detail.reason` は `INVALID_FLAVOUR`

### Requirement: SPEC-VERIFY-COMMON-ERRORS-003 構造の条文に反して読めない文書は INVALID_PDF の所見として返す

文書が ISO 32000 の構造の条文に反していて書かれたとおりに読めないときは `code: "INVALID_PDF"` を返し、`error` に条文の節番号を含める（SHALL）。`hint` に、これは文書についての所見であってサーバーの故障ではないこと（"This is a finding about the file, not a failure of this server"）を書く（SHALL）。`INTERNAL_ERROR` で返さない（SHALL）。PDF でないファイルと 0 バイトのファイルは ISO 32000-2 §7.5.2（ファイルは `%PDF-` で始まる）に反するので、ここに入る。

#### Scenario: PDF でないファイルは INVALID_PDF

- **WHEN** 中身が英文のテキストのファイルを渡す
- **THEN** `code` は `INVALID_PDF`、`error` は `§7.5.2` を含み、`hint` は所見であることを書いている

#### Scenario: 0 バイトのファイルは INVALID_PDF

- **WHEN** 0 バイトのファイルを渡す
- **THEN** `code` は `INVALID_PDF`、`error` は `§7.5.2` を含む

#### Scenario: 組み直す材料の無い文書は INVALID_PDF

- **WHEN** 相互参照表も間接オブジェクトも無い文書を `validate_clauses` に渡す
- **THEN** `code` は `INVALID_PDF` で、`INTERNAL_ERROR` ではない

### Requirement: SPEC-VERIFY-COMMON-ERRORS-004 7 ツールは同じパスの失敗に同じ code を返す

7 ツール（`verify_signatures`・`verify_integrity`・`detect_pades_level`・`identify_conformance`・`validate_conformance`・`validate_clauses`・`evaluate_policy`）は、文書を開く前に同じパスの検査（パスが有る・絶対パス・ファイルが有る・通常のファイル・サイズの上限）を通し、同じ入力に同じ `code` を返す（SHALL）。ファイルが無いことを `INVALID_PDF`（文書についての所見）として返さない（SHALL）。

#### Scenario: validate_clauses も存在しないパスは DOC_NOT_FOUND

- **WHEN** `validate_clauses` に存在しない絶対パスを渡す
- **THEN** `code` は `DOC_NOT_FOUND` で、`INVALID_PDF` ではない

#### Scenario: 7 ツールとも存在しないパスは DOC_NOT_FOUND

- **WHEN** 7 ツールのそれぞれに存在しない絶対パスを渡す
- **THEN** どのツールも `code` は `DOC_NOT_FOUND`

#### Scenario: validate_clauses も相対パスは INVALID_ARGUMENT

- **WHEN** `validate_clauses` に相対パスを渡す
- **THEN** `code` は `INVALID_ARGUMENT`、`detail.reason` は `RELATIVE_PATH`

### Requirement: SPEC-VERIFY-COMMON-ERRORS-005 retryable は code ごとに 1 つの値にする

`retryable` は、引数・フラグ・環境を変えれば同じ判定が成功しうるかを表し、`code` ごとに 1 つの値に決める（SHALL）。`INVALID_ARGUMENT`・`ENCRYPTED_PDF`・`WRONG_PASSWORD`・`VERAPDF_NOT_FOUND`・`VERAPDF_NOT_AVAILABLE` は `true`、`DOC_NOT_FOUND`・`INVALID_PDF`・`FILE_TOO_LARGE`・`INVALID_BYTE_RANGE`・`VERAPDF_NO_RESULT`・`INTERNAL_ERROR` は `false` にする（SHALL）。

#### Scenario: 引数の誤りは再試行できる

- **WHEN** 相対パスを渡す
- **THEN** `retryable` は `true`

#### Scenario: 文書の所見は再試行できない

- **WHEN** PDF でないファイルを渡す
- **THEN** `retryable` は `false`

#### Scenario: すべての code に値が決まっている

- **WHEN** サーバーが返しうる `code` を 1 つずつ確かめる
- **THEN** どの `code` にも `retryable` の値が 1 つ決まっている
