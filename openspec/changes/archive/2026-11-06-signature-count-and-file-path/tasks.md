# Tasks

## 0. 前提

- [x] 0.1 方針は人が決めている（#34 のコメント、2026-11-06）。verify 0.35.0 にまとめる 3 件の 2 件目。ブランチは `fix/verify-0350`

## 1. 受入テスト（先に落ちることを確かめる）

- [x] 1.1 `tests/unit/common-output.test.ts` を足す。名前を「SPEC-VERIFY-COMMON-OUTPUT-<3 桁> <Scenario 名>」で始める。ツールは McpServer に登録した実物を in-memory の transport で呼ぶ（`error-contract.test.ts` と同じ）
- [x] 1.2 変更前の `src/` で落ちることを確かめる

## 2. 実装

- [x] 2.1 `src/utils/formatter.ts` の `renderBody` が `file_path` を受け取り、JSON の最初の項目と markdown の見出しの次の行に書く。7 ツールの呼び出しを直す
- [x] 2.2 `analyzeIntegrity` の `signatureCount` から文書タイムスタンプを除き、`documentTimestampCount` を足す。`evaluate_policy` の `facts` にも足す。markdown の「Signatures:」の行を直す
- [x] 2.3 ツールの説明（description）に `file_path` と `documentTimestampCount` を書く
- [x] 2.4 CI の一覧が終了コード 0

## 3. 確認

- [x] 3.1 `tools/list` の差がツールの説明の文だけであることを確かめる

## 4. 承認と取り込み（人が判断する）

- [x] 4.1 人が `proposal.md` の front matter に `approved: YYYY-MM-DD` と `pr: N` を書く
- [x] 4.2 マージの前に、同じ PR の中で `npx openspec archive signature-count-and-file-path --yes` を実行する
- [x] 4.3 archive の後、正本 `openspec/specs/common-output/spec.md` の先頭に front matter（`spec_id: VERIFY`・`kind: common`・`introduced_by: signature-count-and-file-path`）と Purpose（50 文字以上）を書き足す
- [x] 4.4 `npx openspec validate --all && npx spec-ids check` が通る
