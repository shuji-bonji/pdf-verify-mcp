# Tasks

## 0. 前提

- [x] 0.1 方針は人が決めている（#33 のコメント、2026-11-06）。verify 0.35.0 にまとめる 3 件の 1 件目。ブランチは `fix/verify-0350`

## 1. 受入テスト（先に落ちることを確かめる）

- [x] 1.1 `tests/unit/revision-diff-typing.test.ts` を足す。各 Scenario を 1 件以上のテストにし、名前を「SPEC-VERIFY-VERIFY-INTEGRITY-<3 桁> <Scenario 名>」で始める。検体は `tests/helpers/signed-pdf.ts` の `appendObjectRevision` で組む
- [x] 1.2 変更前の `src/` で 001 と 002 の正のシナリオが落ちることを確かめる

## 2. 実装

- [x] 2.1 `src/services/revision-diff.ts`: `peekObject` の窓をやめ、辞書が閉じるまで（上限 1 MiB）読む
- [x] 2.2 `describeRole`・`classifyChange`: `/Filter`・`/ByteRange`・`/Contents` がそろう untyped の辞書を署名の辞書にする
- [x] 2.3 CI の一覧（check:engines・check・typecheck・test（Node 22・20）・build・check:public-types）が終了コード 0

## 3. 確認

- [x] 3.1 pdf-agent-stack の `contract-like-signed.pdf` で、オブジェクト 27・36 が変更前は `unknown`、変更後は `signature` になることを確かめる
- [x] 3.2 `tools/list` の差が無いことを確かめる

## 4. 承認と取り込み（人が判断する）

- [x] 4.1 人が `proposal.md` の front matter に `approved: YYYY-MM-DD` と `pr: N` を書く
- [x] 4.2 マージの前に、同じ PR の中で `npx openspec archive revision-diff-reads-past-contents --yes` を実行する
- [x] 4.3 archive の後、正本 `openspec/specs/verify-integrity/spec.md` の先頭に front matter（`spec_id: VERIFY`・`kind: tool`・`introduced_by: revision-diff-reads-past-contents`）と Purpose（50 文字以上）を書き足す
- [x] 4.4 `npx openspec validate --all && npx spec-ids check` が通る
