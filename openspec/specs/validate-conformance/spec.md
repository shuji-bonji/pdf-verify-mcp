---
spec_id: VERIFY
kind: tool
approved:
pr:
---
# validate-conformance

## Purpose

`validate_conformance` ツールが、PDF を PDF/A（ISO 19005）または PDF/UA（ISO 14289）の flavour に照らして判定するときの規則を定めます。
flavour の決め方、veraPDF に任せるときと内蔵の規則（native エンジン）で判定するときの違い、暗号化された文書の扱い、判定できなかったことの報告の仕方を扱います。

この初版は、2026-11-02 時点の既存テストが固定している振る舞いを起こしたもので、期待値は変えていません。
起こした範囲は次のテストです（47 件）。

- `tests/unit/validate-conformance.test.ts` の全件（`resolveFlavour`・`veraFlavourId`・native エンジン・veraPDF の選び方・`authoritativeValidation`）
- `tests/unit/validate-pdfua.test.ts` の全件
- `tests/unit/validate-conformance-encrypted.test.ts` の全件（qpdf が無い環境では飛ぶ）
- `tests/unit/validate-conformance-encrypted-pdfa.test.ts` の全件

次のテストもこのツールの振る舞いに触れますが、この初版では起こしていません。
`tests/unit/verapdf-resolve-freshness.test.ts`（veraPDF を探した結果の鮮度）・`tests/unit/response-caps.test.ts`（一覧の件数上限）・`tests/unit/document-scope.test.ts`（`scope`）・`tests/unit/null-valued-entry.test.ts`（PDF/A の個々の規則）・`tests/unit/xmp-schemas.test.ts`（veraPDF の報告の読み方）・`tests/unit/registry.test.ts`（全ツールの引数）。

ISO 19005（PDF/A）の条文は pdf-spec-mcp の収録範囲の外なので、PDF/A の規則に付けた条文番号は、実装の規則（`src/services/pdfa-validator.ts`）が持っている参照を写したものです。ISO 14289-1 の §7.1・§7.4.2・§7.16 は原文で確かめました。

## できないこと

- native エンジンで適合を証明すること（内蔵の規則は ISO 19005 / ISO 14289 の一部だけを見るので、違反が無くても「適合」とは言わない）
- PDF/UA で、代替テキストが内容に合っているかを判定すること（あるかどうかは見るが、適切かどうかは機械では決められない）
- コンテンツストリームの解析が要る PDF/UA の要件（コンテンツの Artifact とタグ付け、ページ内容の自然言語、注釈の Annot タグ、`/Tabs`）を native エンジンで判定すること（近似せず veraPDF に任せる）
- 構造木そのものを報告すること（pdf-reader-mcp の `inspect_tags` の仕事）

## Requirements

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-001 flavour の文字列を解釈し、存在しない flavour を拒む

`flavour` は大文字と小文字を区別せずに読み、`pdfa-<部><水準>`（例: `pdfa-1b`）・水準を省いた `pdfa-<部>`・PDF/A-4 の `pdfa-4` / `pdfa-4e` / `pdfa-4f`・`pdfua-1` / `pdfua-2` を受け付ける（SHALL）。PDF/A-4 は A / B / U の水準を持たないので `pdfa-4b`・`pdfa-4a` は存在しない flavour として扱い、E / F は PDF/A-4 だけの区分なので `pdfa-2e`・`pdfa-3f` も存在しない flavour として扱う（SHALL）。存在しない部（`pdfa-5`・`pdfua-9`）や形の合わない文字列（`pdfx-9z`）を渡されたら、`Invalid flavour` を含むエラーにする（SHALL）。

#### Scenario: 部と水準を読む
- **WHEN** `pdfa-1b` と `PDFA-3` を解釈する
- **THEN** それぞれ PDF/A-1 の B 水準と、水準の無い PDF/A-3 になる

#### Scenario: PDF/A-4 の区分を読む
- **WHEN** `pdfa-4`・`pdfa-4e`・`PDFA-4F` を解釈する
- **THEN** それぞれ区分の無い PDF/A-4・PDF/A-4e・PDF/A-4f になる

#### Scenario: 存在しない組み合わせを拒む
- **WHEN** `pdfa-4b`・`pdfa-4a`・`pdfa-2e`・`pdfa-3f`・`pdfa-5` を解釈する
- **THEN** どれも flavour にならない

#### Scenario: 形の合わない flavour はエラーになる
- **WHEN** `flavour: "pdfx-9z"` または `flavour: "pdfua-9"` で判定する
- **THEN** `Invalid flavour` を含むエラーになる

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-002 flavour を省いたら、文書の XMP の宣言から選ぶ

`flavour` を省いたときは、文書の XMP にある PDF/A（`pdfaid:part` / `pdfaid:conformance`）と PDF/UA（`pdfuaid:part`）の宣言から flavour を選ぶ（SHALL）。部に合わない水準や区分（PDF/A-4 に B、PDF/A-2 に F）が宣言されていたら、その水準や区分だけを捨てて部は残す（SHALL）。PDF/A と PDF/UA の両方を宣言していれば PDF/A を選び、`notes` で `pdfua-1` を案内する（SHALL）。PDF/UA だけを宣言していれば PDF/UA を選ぶ（SHALL）。どちらも宣言していなければ PDF/A-2b で判定し、`notes` に `no PDF/A identification` と書く（SHALL）。

#### Scenario: XMP の PDF/A 宣言を読む
- **WHEN** XMP に PDF/A-2 の B 水準を宣言した文書の flavour を決める
- **THEN** PDF/A-2b になる

#### Scenario: 部に合わない水準を捨てる
- **WHEN** XMP に「部 4・水準 B」または「部 2・区分 F」を宣言した文書の flavour を決める
- **THEN** それぞれ区分の無い PDF/A-4、水準の無い PDF/A-2 になる

#### Scenario: 両方を宣言していれば PDF/A を選ぶ
- **WHEN** XMP に PDF/A-2b と PDF/UA-1 を宣言した文書を flavour を省いて判定する
- **THEN** flavour は PDF/A-2b で、`notes` に `pdfua-1` が出る

#### Scenario: 何も宣言していなければ PDF/A-2b で判定する
- **WHEN** XMP に宣言の無い文書を flavour を省いて判定する
- **THEN** flavour は PDF/A-2b で、`notes` に `no PDF/A identification` が出る

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-003 native エンジンは PDF/A の内蔵の規則で違反を見つける

native エンジンで PDF/A を判定するときは、内蔵の規則ごとに違反を `violations` に `ruleId` 付きで並べ、違反が 1 つでもあれば `compliant` を `false` にする（SHALL）。規則の例は、trailer の `/ID`（`file-id`、ISO 19005-1 §6.1.3）・OutputIntent（`output-intent`、ISO 19005-1 §6.2.2）・暗号化（`no-encryption`、ISO 19005-1 §6.1.3）・LZW（`no-lzw`、ISO 19005-1 §6.1.10）・PDF の版（`pdf-version`。PDF/A-1 は 1.4 まで、PDF/A-4 は 2.0）である（SHALL）。ISO 19005-1〜3 だけの規則（OutputIntent の要求）を PDF/A-4 に当てて決めず、`notes` で ISO 19005-4 に触れる（SHALL）。

#### Scenario: 宣言した PDF/A の違反を見つける
- **WHEN** PDF/A-2b を宣言し、trailer の `/ID` と OutputIntent を持たない文書を native エンジンで判定する
- **THEN** `violations` に `file-id` と `output-intent` があり、`no-encryption` と `no-lzw` は無く、`compliant` は `false`

#### Scenario: PDF/A-1 に対して版が新しすぎる
- **WHEN** PDF 1.7 の文書を `pdfa-1b` で判定する
- **THEN** `violations` に `pdf-version` がある

#### Scenario: PDF/A-4 では版を見て、OutputIntent は決めない
- **WHEN** PDF 1.7 の文書を `pdfa-4f` で判定する
- **THEN** flavour は PDF/A-4f で、`violations` に `pdf-version` があり `output-intent` は無く、`notes` に `ISO 19005-4` が出る

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-004 native エンジンは適合を証明しない

native エンジンは ISO 19005 / ISO 14289 の一部の規則しか見ないので、`compliant` を `true` にしない（SHALL）。違反が見つかれば `false`、見た規則の範囲で違反が無ければ `null` にし、`notes` に一部の規則しか見ていないこと（`SUBSET of ISO 14289` など）を書く（SHALL）。

#### Scenario: 違反の無い文書でも true にならない
- **WHEN** PDF/UA の内蔵の規則をすべて満たす文書を native エンジンで判定する
- **THEN** `violations` は空で、`compliant` は `null`、`notes` に `SUBSET of ISO 14289` が出る

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-005 native エンジンは PDF/UA の文書全体の宣言と設定の欠陥を見つける

native エンジンで PDF/UA を判定するときは、文書全体の宣言と設定の次の欠陥を、それぞれの `ruleId` で `violations` に出す（SHALL）。`/MarkInfo /Marked` が true でない（`ua-marked`、ISO 14289-1 §7.1）・構造木が無い（`ua-struct-tree`、§7.1）・`/Lang` が無い（`ua-lang`、§7.2）・`DisplayDocTitle` が true でない（`ua-display-doc-title`、§7.1）・文書の題が無い（`ua-title`、§7.1。Info の `/Title` だけでは足りず、XMP の `dc:title` が要る）・`pdfuaid` の宣言が無いか、判定を求めた部と違う（`ua-xmp-declaration`、§5）。

#### Scenario: Marked が無い
- **WHEN** `/Marked` を持たない文書を `pdfua-1` で判定する
- **THEN** `violations` に `ua-marked` があり、`compliant` は `false`

#### Scenario: XMP の dc:title が無い
- **WHEN** Info の `/Title` はあるが XMP に `dc:title` が無い文書を判定する
- **THEN** `ua-title` の違反の `detail` に `Info /Title is set but XMP has no dc:title` が出る

#### Scenario: 宣言した部と判定を求めた部が違う
- **WHEN** PDF/UA-2 を宣言した文書を `pdfua-1` で判定する
- **THEN** `ua-xmp-declaration` の違反の `detail` に `declares PDF/UA-2 but validation requested PDF/UA-1` が出る

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-006 PDF/UA の違反は error と warning を分ける

PDF/UA の内蔵の規則の違反は `severity` に `error` か `warning` を持ち、`error` の違反だけが `compliant: false` を確定させる（SHALL）。`warning` は人が確かめる項目として残す（SHALL）。

#### Scenario: 確定する違反は error
- **WHEN** `/Marked` を持たない文書を判定する
- **THEN** `ua-marked` の違反の `severity` は `error`

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-007 暗号化された文書の PDF/UA 判定は、復号してから構造の規則を見る

暗号化された文書を PDF/UA で判定するときは、空の利用者パスワードで復号を試み、通れば復号してからすべての規則を見て、`notes` に `decrypted before validation` と書く（SHALL）。`password` を渡されたらそのパスワードで復号し、すべての規則を見る（SHALL）。違うパスワードは `WRONG_PASSWORD` のエラーにする（SHALL）。veraPDF に渡すために作る平文の写しは、厳しい検査（`qpdf --check`）を通る形で作る（SHALL）。

#### Scenario: 権限パスワードだけの文書を自動で復号する
- **WHEN** 空の利用者パスワードで開ける暗号化文書を `pdfua-1` で判定する
- **THEN** `checkedRules` は 12、`violations` は空、`compliant` は `null` で、`notes` に `decrypted before validation` が出る

#### Scenario: 違うパスワード
- **WHEN** 利用者パスワードが要る文書に違うパスワードを渡す
- **THEN** `WRONG_PASSWORD` のエラーになる

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-008 復号できなかった構造の規則は、違反ではなく見ていないと報告する

利用者パスワードが要る文書を、パスワード無しで PDF/UA 判定するときは、構造に頼る規則を `skippedRules` に数え、違反にしない（SHALL）。このとき `compliant` は `null` にし、`notes` に `could not be decrypted` と書く（SHALL）。

#### Scenario: パスワードの分からない文書
- **WHEN** 利用者パスワードが要る文書をパスワード無しで `pdfua-1` で判定する
- **THEN** `skippedRules` は 11、`checkedRules` は 1、`violations` は空で、`compliant` は `null`

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-009 暗号化辞書の P キーの第 10 ビットを、元の暗号化辞書で判定する

暗号化された文書を PDF/UA で判定するときは、復号した後でも元の暗号化辞書の `/P` を見て、第 10 ビット（支援技術のための取り出し）が立っていなければ `ua-no-encryption-barrier` の違反（`severity: error`）にする（SHALL。ISO 14289-1 §7.16）。暗号化辞書に数値の `/P` が無いときも違反にする（SHALL）。

#### Scenario: 第 10 ビットが立っていない
- **WHEN** `/P` の第 10 ビットを落として暗号化した文書を判定する
- **THEN** 違反は `ua-no-encryption-barrier` だけで、`detail` に `bit 10` が出て、`compliant` は `false`

#### Scenario: P キーが無い
- **WHEN** `/P` を持たない暗号化辞書で規則を当てる
- **THEN** `ua-no-encryption-barrier` は通らず、`detail` に `no numeric /P key` が出る

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-010 暗号化された文書を veraPDF に渡さない

PDF/A の判定で veraPDF を使う場面で文書が暗号化されていたら、veraPDF を呼ぶ前に `ENCRYPTED_PDF` のエラーにし、`INTERNAL_ERROR` にしない（SHALL）。native エンジンでは例外にせず、`no-encryption` の違反として報告する（SHALL）。

#### Scenario: veraPDF を使う場面の暗号化文書
- **WHEN** veraPDF が使える状態で、暗号化された文書を `pdfa-3b`・`engine: "auto"` で判定する
- **THEN** `ENCRYPTED_PDF` のエラーになる

#### Scenario: native エンジンの暗号化文書
- **WHEN** 暗号化された文書を `pdfa-3b`・`engine: "native"` で判定する
- **THEN** `violations` に `no-encryption` があり、`compliant` は `false`

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-011 veraPDF に渡す profile の ID は、実在するものだけにする

veraPDF に判定を任せるときの profile の ID は、PDF/A-1〜3 では部と水準（水準が無ければ `b`）から作り、PDF/A-4 では `4`・`4e`・`4f` のどれかにする（SHALL）。`4b` は作らない（SHALL）。

#### Scenario: PDF/A-1〜3
- **WHEN** PDF/A-1 の B 水準、PDF/A-2 の U 水準、水準の無い PDF/A-3 の ID を作る
- **THEN** `1b`・`2u`・`3b` になる

#### Scenario: PDF/A-4
- **WHEN** 区分の無い PDF/A-4、PDF/A-4e、PDF/A-4f の ID を作る
- **THEN** `4`・`4e`・`4f` になる

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-012 PDF_VERIFY_VERAPDF が指す実行ファイルだけを使う

環境変数 `PDF_VERIFY_VERAPDF` が実行できるファイルを指していれば、それを veraPDF として使い、出どころを `source: "env"` と記録する（SHALL）。実行できないパスを指していれば、見つかったことにせず `reason: "configured_path_unusable"` と `configuredPath` を返し、PATH にある別の実行ファイルで代えない（SHALL）。

#### Scenario: 実行できるパス
- **WHEN** `PDF_VERIFY_VERAPDF` に実行できるファイルのパスを入れる
- **THEN** `available: true`・そのパス・`source: "env"` が返る

#### Scenario: 実行できないパス
- **WHEN** `PDF_VERIFY_VERAPDF` に存在しないパスを入れる
- **THEN** `available: false`・`reason: "configured_path_unusable"`・`configuredPath` が返り、PATH の veraPDF も使わない

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-013 engine に verapdf を求められて使えなければ、エラーにする

`engine: "verapdf"` を渡されたのに veraPDF を使えないときは、native エンジンで代えずにエラーにする（SHALL）。`PDF_VERIFY_VERAPDF` が実行できないパスを指しているときのエラーの `code` は `VERAPDF_NOT_AVAILABLE` にする（SHALL）。

#### Scenario: 設定したパスが使えない
- **WHEN** `PDF_VERIFY_VERAPDF` が存在しないパスを指す状態で `engine: "verapdf"` で判定する
- **THEN** `code: "VERAPDF_NOT_AVAILABLE"` のエラーになる

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-014 veraPDF で判定しなかったことを、結果の前に報告する

veraPDF で判定しなかったときは、`authoritativeValidation` に `performed: false`・`validator: "verapdf"`・理由（`not_installed`・`configured_path_unusable`・`native_engine_requested`）を入れる（SHALL）。`notes` にも、判定が行われなかったこと（`NOT performed`）と、native の結果では適合を証明できないこと（`cannot certify`）を書き、設定したパスが使えなかったときはそのパスを書く（SHALL）。PDF/UA の判定でも同じように報告する（SHALL）。`engine: "native"` を渡されたときの理由は `native_engine_requested` で、veraPDF が無いようには書かない（SHALL）。

#### Scenario: 設定したパスが使えず native で判定した
- **WHEN** `PDF_VERIFY_VERAPDF` が存在しないパスを指す状態で `engine: "auto"` で判定する
- **THEN** `engine` は `native`、`authoritativeValidation` は `performed: false`・`reason: "configured_path_unusable"` で、`notes` にそのパスと `NOT performed`・`cannot certify` が出る

#### Scenario: native を求められた
- **WHEN** `engine: "native"` で判定する
- **THEN** `authoritativeValidation` は `performed: false`・`reason: "native_engine_requested"`

### Requirement: SPEC-VERIFY-VALIDATE-CONFORMANCE-015 native エンジンは PDF/UA の構造木と注釈の欠陥を見つける

native エンジンで PDF/UA を判定するときは、構造木と注釈の次の欠陥を、それぞれの `ruleId` で `violations` に出す（SHALL）。代替テキストの無い Figure（`ua-figure-alt`、ISO 14289-1 §7.3）・見出しが H1 から始まらないか段を飛ばす（`ua-heading-hierarchy`、§7.4.2）・TH / TR の無い表（`ua-table-headers`、§7.5）・`/Contents` の無い Link 注釈（`ua-link-contents`、§7.18.5）。構造の型は `/RoleMap` を辿って標準の型に読み替えてから規則に当てる（SHALL）。

#### Scenario: 代替テキストの無い Figure
- **WHEN** `/Alt` の無い Figure を 1 つ持つ文書を判定する
- **THEN** `ua-figure-alt` の違反の `detail` に `1 of 1 Figure` が出る

#### Scenario: 見出しの段を飛ばす
- **WHEN** 構造木の見出しが H1、H3 の順に並ぶ文書を判定する
- **THEN** `ua-heading-hierarchy` の違反の `detail` に `H1 followed by H3` が出る

#### Scenario: RoleMap で見出しに読み替える
- **WHEN** 独自の型 `MyHeading` を `/RoleMap` で H1 に対応させた文書を判定する
- **THEN** `ua-heading-hierarchy` の違反は出ない
