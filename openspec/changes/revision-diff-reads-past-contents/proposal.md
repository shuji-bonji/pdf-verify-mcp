---
approved: 2026-11-06
pr: 38
implementation: required
targets: [verify-integrity]
---

# Proposal

## Why

`verify_integrity` のリビジョン差分で、増分更新が足した署名の辞書と文書タイムスタンプの辞書が `type: null`・`role: null`・`changeClass: "unknown"` になります（#33・F-24）。同じオブジェクトを pdf-reader-mcp の `locate_objects` は `Sig`・`DocTimeStamp` と返します。

原因は `src/services/revision-diff.ts` の `peekObject` が、オブジェクトの先頭から 4,096 バイト（`OBJECT_PEEK_BYTES`）だけを走査していることです。`/Contents` の 16 進文字列が `/Type` より前にあると、走査が文字列の途中で終わり、`/Type` まで届きません。`eval/hosts/grok-build/fixtures/incoming/contract-like-signed.pdf`（pdf-agent-stack）では、オブジェクト 27（署名の辞書）の `/Type` が 14,901 バイト目、オブジェクト 36（文書タイムスタンプの辞書）の `/Type` が 7,803 バイト目にあります。

`changeClass: "unknown"` は、DocMDP の評価で `assessment: "indeterminate"` になります。P=2・P=3 で許される署名の追加が、許されたかどうか決められない変更として扱われます。

ISO 32000-2 §12.8.1 Table 255 では、署名の辞書の `Type` は Optional（既定値 `Sig`）、文書タイムスタンプの辞書では Required（`DocTimeStamp`）です。`Filter` は Required、`Contents` は Required、`ByteRange` は署名フィールドの署名で Required です。辞書のキーの順序は決まっていないので、`/Contents` が先に来る文書は正当です。

`verify_integrity` の仕様はまだありません。この変更で capability `verify-integrity` の初版を起こし、リビジョン差分でオブジェクトの種類を読む振る舞いだけを書きます。

## What Changes

- `peekObject` は 4,096 バイトの窓で切らず、辞書が閉じるまで読む。16 進文字列とリテラル文字列は閉じる記号まで読み飛ばす。閉じない辞書で走査がファイルの終わりまで進まないよう、1 オブジェクトあたりの上限（1 MiB）を置く。
- `/Type` を持たない辞書でも、`/Filter`・`/ByteRange`・`/Contents` の 3 つがそろっていれば署名の辞書と見なし、`role: "signature dictionary"`・`changeClass: "signature"` にする（Table 255 の Required の項目と、`Type` の既定値 `Sig`）。`type` は書かれていた値（`null`）のまま返す。

### 変わる振る舞い

- `/Contents` が `/Type` より前にあり、オブジェクトの先頭から 4,096 バイトを超えた位置に `/Type` がある辞書の `type`・`role`・`changeClass`。
- `/Type` の無い署名の辞書の `role`・`changeClass`。
- その結果としての `certification.violationAssessment`（`indeterminate` だったものが `permitted` または `violated` になる）。

### 変わらない振る舞い

- オブジェクトストリームの中のオブジェクトは今までどおり `unknown`（バイトを展開しない）。
- `/Type` を 4,096 バイトの窓の中に持つオブジェクトの応答。
- `tools/list` の応答。

### 対象外

- オブジェクトストリームの中のオブジェクトの種類を読むこと。
- ほかの untyped な辞書の見分け方（AcroForm・DSS・文書情報辞書）。

## Capabilities

- `verify-integrity`（新規。`kind: tool`。ADDED: 001・002）

起こす範囲は、リビジョン差分で変わったオブジェクトの種類を読む振る舞いだけです。DocMDP の評価・`revisionChain`・`revisionCountAgreement` は既存のテスト（`tests/unit/verify-integrity.test.ts`）が固定していて、この変更では起こしません。

## 人が判断すること

- 1 オブジェクトあたりの走査の上限を 1 MiB にすること。署名の `/Contents` は実運用で数十 KB までです。上限で切れたときは、今までどおり読めたキーだけで見分けます。
- `/Type` の無い辞書を署名の辞書と見なす条件を `/Filter`・`/ByteRange`・`/Contents` の 3 つにすること（`/SubFilter` は Optional なので条件に入れません）。
