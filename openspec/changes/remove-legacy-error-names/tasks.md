# Tasks

## 0. 前提

- [x] 0.1 人が proposal.md を承認している（2026-11-05 21:52 にチャットで旧名の削除を依頼された。`approved` は人が書く。ブランチは `feat/remove-legacy-error-names`）

## 1. 受入テスト（先に落ちることを確かめる）

- [x] 1.1 `tests/unit/error-contract.test.ts` の最上位の項目の検査から `message`・`suggestion` を外し、001 に「移行の版の旧い名前を返さない」を足す
- [x] 1.2 006 の describe を消し、テスト名から SPEC-VERIFY-COMMON-ERRORS-006 を外す。`tests/unit/document-scope.test.ts` の `legacyCode` の期待を外す
- [x] 1.3 変更前の `src/` で 1.1 が落ちることを確かめる

## 2. 実装

- [x] 2.1 `src/utils/error-handler.ts`: `LEGACY_CODE`・`legacyCode`・`message`・`suggestion` を外し、`detail` を書くことがあるときだけ置く
- [x] 2.2 README（英日）・CHANGELOG（英語）を直す

## 3. 確認

- [x] 3.1 CI と同じ一覧（`.github/workflows/ci.yml`）が終了コード 0
- [x] 3.2 `npx openspec validate --all && npx spec-ids check` が通る

## 4. 承認と取り込み（人が判断する）

- [ ] 4.1 人が `proposal.md` の front matter に `approved` と `pr` を書く
- [ ] 4.2 マージの前に `npx openspec archive remove-legacy-error-names --yes` を実行する（チェックは archive の前に入れる）
