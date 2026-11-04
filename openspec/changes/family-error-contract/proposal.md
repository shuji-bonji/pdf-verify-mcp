---
approved:
pr:
implementation: required
targets: [common-errors]
---

# Proposal

## Why

PDF family のエラー応答の規約（pdf-agent-stack `docs/specs/06` §2.3。2026-11-04 改訂、pdf-agent-stack#48）は、ツール結果の本文を平らな JSON（`error` 英語の文・`code`・`retryable` が必須、`hint`・`next_actions`・`detail` が任意）にし、同じ状況には同じ `code`（houki-hub family の共通語彙）を返すと定めました。reader・writer・spec はこの形でそろっていて、ずれているのは verify だけです（pdf-verify-mcp#35）。

0.32.2 の `identify_conformance` に 4 種類の失敗の入力を渡した結果（pdf-agent-stack `eval/e2e/tests/s6-error-contract.test.mjs`）:

| 入力 | 0.32.2 の `code` | 同じ状況の共通語彙 |
| --- | --- | --- |
| 存在しないパス | `FILE_NOT_FOUND` | `DOC_NOT_FOUND` |
| PDF でないファイル | `PARSE_FAILED` | `INVALID_PDF` |
| 0 バイトのファイル | `PARSE_FAILED` | `INVALID_PDF` |
| 相対パス | `RELATIVE_PATH` | `INVALID_ARGUMENT` |

4 件とも、`error` が `true`（文字列でない）、`retryable` が無い、規約に無い最上位の項目（`message`・`suggestion`）がある、でも契約に反しています。

あわせて、`validate_clauses` だけが存在しないパスを `PARSE_FAILED`（文書についての所見）で返し、`suggestion` で「構造上の違反として記録する」よう案内しています（pdf-verify-mcp#32）。ほかの 6 ツールは同じ入力に `FILE_NOT_FOUND` を返します。

エラーの振る舞いを固定している仕様はまだありません。7 ツールに共通する振る舞いなので、共通の capability `common-errors`（`kind: common`）として初版を起こします。

## What Changes

- エラー応答の本文を規約の形にする。`error` は英語の 1 文（0.32.2 の `message` の値）、`hint` は 0.32.2 の `suggestion` の値、`retryable` を常に書く。
- `code` を共通語彙にそろえる。`FILE_NOT_FOUND` → `DOC_NOT_FOUND`、`PARSE_FAILED` → `INVALID_PDF`、`MISSING_PATH`・`RELATIVE_PATH`・`NOT_A_FILE`・`INVALID_FLAVOUR` → `INVALID_ARGUMENT`（旧名は `detail.reason`）。
- verify 固有のコード（`INVALID_BYTE_RANGE`・`WRONG_PASSWORD`・`VERAPDF_NOT_FOUND`・`VERAPDF_NOT_AVAILABLE`・`VERAPDF_NO_RESULT`）と、すでに共通語彙の名前のコード（`ENCRYPTED_PDF`・`FILE_TOO_LARGE`・`INTERNAL_ERROR`）は名前を変えない。
- `validate_clauses` は、文書を開く前にほかの 6 ツールと同じパスの検査を通す（#32）。
- 移行の版（この変更を入れる minor）のあいだは、旧い名前も返す（#48 で決定）: `detail.legacyCode` に 0.32.x で返していた `code`、最上位の `message` に `error` と同じ値、`suggestion` に `hint` と同じ値。

### 変わる振る舞い

- エラーの本文の `error` が `true` から英語の文になる。`code` が上の表のとおり変わる。`retryable`・`hint`・`detail` が加わる。
- `validate_clauses` に存在しないパスを渡すと `DOC_NOT_FOUND` になる（これまでは `PARSE_FAILED`）。相対パス・フォルダー・サイズ上限超えも、ほかの 6 ツールと同じ `code` になる。

### 変わらない振る舞い

- 成功したときの出力（7 ツールとも）。
- どの入力がエラーになるか（`validate_clauses` のパスの検査を除く）。エラーの文（`message` の値）と案内（`suggestion` の値）の文言。
- `isError: true` で返すこと。SDK が前段で落とす入力検証の失敗（宣言に無いキーなど）は、SDK の文言のまま返す（§2.11。2026-08-27 決定、#48 で再確認）。
- `VERAPDF_NOT_FOUND`・`VERAPDF_NOT_AVAILABLE` の分け方（SPEC-VERIFY-VALIDATE-CONFORMANCE-013）。

### 対象外

- 旧い名前（`detail.legacyCode`・`message`・`suggestion`）を外すこと。その次の minor で別の変更として出す。
- `next_actions` を付けること。`action` の値は Skill が分岐に使う約束になり、変えると破壊的変更になるので、付ける手を決めてから別の変更で出す。
- `hint` の文言を書き直すこと。
- reader・writer・spec の `retryable`（それぞれの Issue で直す）。

## Capabilities

- `common-errors`（新規。`kind: common`。ADDED: 001〜006）

## 人が判断すること

- 版。`code` の値が変わるので minor（0.33.0）を提案します。旧名を外すのは 0.34.0。
- `retryable` の値（design.md の表）。とくに `DOC_NOT_FOUND` を `false` にすること（§2.3 の例に合わせた）と、`VERAPDF_NOT_FOUND`・`VERAPDF_NOT_AVAILABLE` を `true` にすること（`engine: "native"` に変えれば通るため）。
- 移行の版のあいだ、`detail.legacyCode` を名前の変わらないコードにも付けること（design.md の「旧名の付け方」）。
