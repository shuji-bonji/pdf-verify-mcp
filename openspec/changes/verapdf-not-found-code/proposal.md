---
approved:
pr:
implementation: required
targets: [validate-conformance]
---

# Proposal

## Why

`engine: "verapdf"` を渡されたのに veraPDF を使えないとき、`validate_conformance` は native エンジンで代えずにエラーを返します（SPEC-VERIFY-VALIDATE-CONFORMANCE-013）。エラーの `code` は理由で 2 つに分かれています。0.13.0 で意図して分けたものです（CHANGELOG 0.13.0）。

| 理由 | `code` | `tools/list` の説明 | 正本の 013 | 固定しているテスト |
| --- | --- | --- | --- | --- |
| `PDF_VERIFY_VERAPDF` が実行できないパスを指す（`configured_path_unusable`） | `VERAPDF_NOT_AVAILABLE` | 書いてある | 書いてある | 環境変数を使うテスト 1 件（どの環境でも走る） |
| どこにも入っていない（`not_installed`） | `VERAPDF_NOT_FOUND` | **書いていない** | **書いていない** | 1 件。ただし veraPDF のある環境では先頭で `return` して何も確かめず、確かめるときも `code` ではなく文言だけを見る |

このため、`VERAPDF_NOT_FOUND` は利用者から見えず、どのテストを落としても守られていません。編成する Skill がエラーの `code` で分岐する（docs/family-standards-alignment.md）以上、返しうる `code` は説明と仕様に書き、どの環境でも走るテストで固定する必要があります。

## What Changes

- 013 を書き換え、veraPDF がどこにも入っていないときのエラーの `code` を `VERAPDF_NOT_FOUND` と定める。
- `tools/list` の `validate_conformance` の説明に、`not_installed` のときの `VERAPDF_NOT_FOUND` を書く。
- veraPDF の探し方（環境変数 → PATH → 決まった場所）のうち、決まった場所の候補をテストから差し替えられるようにし、veraPDF のある環境でも「どこにも無い」を作って確かめられるようにする。

### 変わる振る舞い

- `tools/list` の `validate_conformance` の description に `VERAPDF_NOT_FOUND` が出る。

### 変わらない振る舞い

- エラーの `code`・`message`・`hint` の値（0.13.0 からの `VERAPDF_NOT_FOUND` / `VERAPDF_NOT_AVAILABLE` の分け方をそのまま仕様にする）。
- veraPDF の探し方の順序と、設定したパスが使えないときに他の実行ファイルで代えないこと（012）。
- `engine: "auto"` で veraPDF が無いときに native エンジンで判定し、`authoritativeValidation` で報告すること（014）。
- 他の 6 ツールの出力。

### 対象外

- 2 つの `code` を 1 つにまとめること（family のエラー語彙の統一は別の話題）。
- `evaluate_policy` など、veraPDF を使う他のツールのエラー。

## Capabilities

- `validate-conformance`（MODIFIED: 013）

## 人が判断すること

- 版（description の追記だけで出力の値は変わらないので、patch の 0.32.1 を提案する）。
- 決まった場所の候補をテストから差し替える入口を、実装のモジュールに置いてよいか（design.md の「差し替えの入口」）。
