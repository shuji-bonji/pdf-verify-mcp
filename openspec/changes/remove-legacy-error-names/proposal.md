---
approved:
pr:
implementation: required
targets: [common-errors]
---

# Proposal

## Why

0.33.0（変更 `family-error-contract`、#35）はエラー応答を PDF family の形（pdf-agent-stack `docs/specs/06` §2.3）に移し、移行の版として 1 つの minor のあいだだけ旧い名前も返すと決めました（SPEC-VERIFY-COMMON-ERRORS-006。2026-11-04 決定）。その minor が 0.33.x で、次の minor（0.34.0）で外すことになっています。

受け側の準備は済んでいます（2026-11-05 時点）。

| 受け側 | 状態 |
|---|---|
| pdf-trust Skill | v0.8.4 から新旧両方の名前を読む（`code`・`hint` を先に読み、無いときだけ旧名） |
| pdf-publish Skill | v0.7.2 から `code` だけで分岐し、旧名では分岐しないと書いている |
| サイトの `reference/error-codes` | 新しい名前を正として書き、旧名は「移行のあいだ」の表だけ |
| pdf-agent-stack の S6 | `detail.legacyCode` があるときだけ `message`・`suggestion` を許す（無ければ許さない） |

## What Changes

- すべてのエラーから `detail.legacyCode` を外す。
- 最上位の `message`（`error` と同じ値）と `suggestion`（`hint` と同じ値）を外す。
- `detail` は、書くことがあるとき（`INVALID_ARGUMENT` の `detail.reason`）だけ置く。

### 変わる振る舞い

- エラーの本文から `message`・`suggestion`・`detail.legacyCode` が無くなる。`INVALID_ARGUMENT` 以外のエラーでは `detail` そのものが無くなる。
- 型 `StructuredError` から `message`・`suggestion`・`detail.legacyCode` が無くなり、`detail` が任意になる。`PdfVerifyError` の `legacyCode` を外す。

### 変わらない振る舞い

- `error`・`code`・`retryable`・`hint` と、`INVALID_ARGUMENT` の `detail.reason`。どの入力がどの `code` になるか。`retryable` の値。
- 成功したときの出力。

### 対象外

- 正本 `common-errors` の Purpose は「移行の版のあいだ旧い名前も返すこと」に触れているが、OpenSpec の差分は Purpose を書き換えない。archive の後に人が直すか、そのまま残すかを決める。

## Capabilities

- `common-errors`（MODIFIED: 001。REMOVED: 006）

## 人が判断すること

- 版。応答の項目が減る破壊的変更だが、0.x の minor（0.34.0）で外すことは 2026-11-04 に決めている。
