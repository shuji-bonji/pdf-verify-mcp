---
approved: 2026-11-06
pr: 38
implementation: required
targets: [common-output]
---

# Proposal

## Why

verify の成功の応答で、次の 2 点が利用者の読み取りを誤らせます（#34・F-17・F-29）。

1. **同じ名前の項目が、ツールによって違うものを数える。** 署名 1 本と文書タイムスタンプ 1 本を持つ `contract-like-signed.pdf` で、`evaluate_policy` の `facts.signatureCount` は 1（`src/tools/evaluate-policy.ts` が `!s.isDocumentTimestamp` で絞る）、`verify_integrity` の `signatureCount` は 2（`src/services/verification-service.ts` が `ByteRange` と `Contents` を持つ辞書をすべて数える）です。
2. **応答に入力の `file_path` が無い。** E4 の UC06 で `evaluate_policy` を 4 件同時に呼んだとき、応答を入力のパスに対応づける手がかりが `scope.objects` しかありませんでした。ほかの 6 ツールも同じです。

2 つとも 7 ツールに共通する成功の応答の項目なので、共通の capability `common-output`（`kind: common`）の初版を起こします。

## What Changes

- 7 ツールの成功の応答の最上位に、受け取った `file_path` をそのまま返す。JSON では最初の項目、markdown では見出しの次の行（`File: <パス>`）に書く。
- `signatureCount` は、どのツールでも**文書タイムスタンプを除いた署名の数**にする。文書タイムスタンプの数は `documentTimestampCount` として隣に返す。`verify_integrity` の `signatureCount` と、`evaluate_policy` の `facts.signatureCount` が対象。
- markdown の「Signatures:」の行に文書タイムスタンプの数も書く。

### 変わる振る舞い

- 7 ツールの JSON に `file_path` が加わる（項目の追加）。markdown に `File:` の行が加わる。
- `verify_integrity` の `signatureCount` の値（文書タイムスタンプを持つ文書では減る）。`IntegrityReport` 型に `documentTimestampCount` が加わる。
- `evaluate_policy` の `facts` に `documentTimestampCount` が加わる。

### 変わらない振る舞い

- エラーの本文（`common-errors` の形のまま。`file_path` を足さない）。
- `evaluate_policy` の `facts.signatureCount` の値（すでに文書タイムスタンプを除いている）。
- 判定（`verdict`・`compliant`・`violationAssessment` など）。

### 対象外

- 鍵を導けない暗号化文書で数を `null` にすること（`unauthenticated-encrypted-document` の変更で扱う）。
- `detect_pades_level` の `levels` の件数の数え方。

## Capabilities

- `common-output`（新規。`kind: common`。ADDED: 001・002）

## 人が判断すること

- 版。`verify_integrity` の `signatureCount` の値が変わるので、0.35.0（minor）にまとめる提案です。
- `file_path` を JSON の最初の項目に置くこと（いまの最初は `scope`。CLAUDE.md の「どこまで読んだかを先に置く」の規律より前に置きます。どのファイルの応答かは、読んだ範囲より先に分かる必要があるためです）。
- エラーの本文には `file_path` を足さないこと。
