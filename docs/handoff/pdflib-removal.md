# 引き継ぎ: pdf-verify-mcp の pdf-lib 撤去（normativepdf 0.8.0 へ）

- 対象リポジトリ: `pdf-verify-mcp`（この文書のある repo）
- 起票: 2026-08-27
- **family の pdf-lib 撤去の第 2 弾**。第 1 弾は writer（Phase 3・2026-08-18 受入充足）。
  reader は第 3 弾として別に起こす（normativepdf `docs/ROADMAP.md` Phase 1 の未チェック項目
  「reader から使わせる（第 2 消費者）」）
- **これはトラック B の第 3 段（B2）。** 前段は 2 つある:
  1. **N** = normativepdf の §7.9 文字列層（`lib/normativepdf/docs/handoff/text-string-and-date.md`）
     — `pdfua-validator.ts` の `decodeText()` × 19 の置き換え先
  2. **B1** = pdf-constraints の pdf-lib 撤去（`lib/pdf-constraints/docs/handoff/pdflib-removal.md`）
     — 🔴 **B1 を先にやらないと、本作業の受入面 1 が満たせない**（§6 面 1）
- トラック A（`information/issue-draft-08-sdk-v2-and-version-alignment.md`
  = SDK v2 移行を目的とした版統一）とは接点が無い。**実測で確認済み**（2026-08-27）:

  ```
  SDK に触る   : src/index.ts + src/tools/*.ts（9 件）
  pdf-lib に触る: src/services/*.ts（5 件）
  両方に触る   : 0 件
  ```

- 前提はトラック A の **A1（版の土台 = TypeScript 7 / @types/node 22 / engines / CI）だけ**。
  型検査が動かないと何も測れないため。A1 が済めば A2〜A4（zod 4 / SDK v2 / 入力検証）とは
  **並行して進めてよい**
- 🔴 **TypeScript 7 移行と同じリリースに混ぜない。** TS 7 は 6.0 の非推奨をハードエラーにし、
  `strict` と `esnext` を既定にするので、原因が 2 つになる。A1 で先に済ませておく
- この文書だけで着手できる
- **起票先: [shuji-bonji/pdf-agent-stack#21](https://github.com/shuji-bonji/pdf-agent-stack/issues/21)**（トラック B の第 3 段 = B2）

---

## 1. いま何が pdf-lib の上にあるか（実測 2026-08-27）

`grep -rl "from 'pdf-lib'" src/` = **5 ファイル / 33 ファイル中**。
`package.json` の `dependencies` に `pdf-lib: ^1.17.1`。

| ファイル | 行数 | pdf-lib 由来の識別子の出現回数 | `lookup` 系 | 既存 `await` |
|---|---|---|---|---|
| `services/pdf-parser.ts` | 504 | 73 | 24 | 3 |
| `services/pdfua-validator.ts` | 559 | 67 | 26 | **0** |
| `services/pdfa-validator.ts` | 463 | 44 | 15 | **0** |
| `services/decrypt-document.ts` | 196 | 28 | 1 | 3 |
| `services/conformance-validation.ts` | 447 | 3 | 1 | 12 |

import している記号は重複を除いて 15 種（`PDFArray` `PDFBool` `PDFDict` `PDFDocument` `PDFHexString` `PDFInvalidObject` `PDFName` `PDFNumber` `PDFObjectParser` `PDFObjectStreamParser` `PDFRawStream` `PDFRef` `PDFString` `PDFWriter` `decodePDFRawStream`）。**そのすべてが COS プリミティブか文書ローダで、
高レベル API は `doc.getPages()` の 2 箇所（`pdfua-validator.ts:175` / `:385`）だけ**である。
writer が Phase 3 で越えた面（描画・フォント埋め込み・AcroForm・直列化）はここには無い。

`PDFDocument` 型が波及しているのも上の 4 ファイル（`conformance-validation.ts` を除く）に閉じている。

## 2. 対応表

| pdf-lib | normativepdf 0.8.0 | 備考 |
|---|---|---|
| `PDFDict` / `PDFArray` / `PDFName` / `PDFNumber` / `PDFString` / `PDFHexString` / `PDFBool` / `PDFRef` / `PDFRawStream` | `CosDict` / `CosArray` / `CosName` / `CosInteger`・`CosReal` / `CosString` / `CosBoolean` / `CosRef` / `CosStream` | `dictGet` / `dictGetRaw` で引く |
| `PDFDocument.load(bytes)` | `parsePdf(bytes, { password })` | **復号込み**（§7.6.2 の例外 4 種を実装済み） |
| `doc.context.lookup(...)` | `await doc.resolve(...)` / `await doc.getObject(n, g)` | **async になる** |
| `doc.catalog` | `await doc.getCatalog()` | |
| `doc.getPages()` | `readPageTree` / `PageEntry` / `inheritedAttribute` | 継承の解決つき（§7.7.3.4） |
| `decodePDFRawStream` | `decodeStream` | 自前 inflate（RFC 1950/1951）+ Predictor 全 5 タグ |
| `PDFName#decodeText()` | `CosName.value` | `#xx` 解決と UTF-8 復号は lexer が済ませている（R-7.3.5-13） |
| `PDFObjectParser` / `PDFObjectStreamParser` / `PDFWriter` | `parseObject` / `loadObjectStream` / `writeFile` | `decrypt-document.ts` のみ |
| **`PDFString#decodeText()` / `PDFHexString#decodeText()`** | **無い** | **未決 1（§6）** |

`CosString` は `{ bytes, form }` しか持たない。テキスト文字列の復号（§7.9.2）は
normativepdf の公開面に無く、`pdfua-validator.ts` が `decodeText()` を 11 箇所以上で使っている
（`/Lang`・`/Alt`・`/Title`・RoleMap など）。

## 3. async の波及は 2 段で止まる（実測）

pdf-lib の `lookup` は同期、normativepdf の `resolve` / `getObject` は async である。
影響を受けるのは、いま **`await` を 1 つも持たない同期関数** 2 本:

```
validatePdfaNative   (pdfa-validator.ts:418)  lookup 15 / await 0
validatePdfuaNative  (pdfua-validator.ts:470) lookup 26 / await 0
```

この 2 本の呼び出し元は 1 か所ずつで、**どちらも既に async の中にある**:

```
conformance-validation.ts:288   const native = validatePdfaNative(parsed, doc, flavour);
conformance-validation.ts:418   const native = validatePdfuaNative(target, doc, flavour, {...});
```

その `validateConformance` は `export async function`（:225）で、呼び出す `validate-conformance.ts` の
ハンドラも元から `async`（:83）である。**したがって波及は「2 本を async にする + 呼び出し側に
`await` を 2 つ足す」で止まる。** verify のツール層より上には出ない。

`pdf-parser.ts` の `loadPdfDocument` / `parsePdf` / `parsePdfBytes` は既に async なので、
入口の形は変わらない。

## 4. 正味で減る見込み — `decrypt-document.ts`（196 行）

現行の構成（ファイル冒頭のコメントより）:

> pdf-lib は暗号化オブジェクトストリームの中のオブジェクトをパースできないため、
> `ua-struct-tree` のような規則が「構造が無い」と見てしまう。

そこで 2 パスにしている。①`ignoreEncryption` で開き、xref 内の全ストリームと文字列を復号し、
`/Encrypt` を落として保存 → ②呼び出し側が保存バイト列を再パースする。

normativepdf 0.8.0 は `parsePdf(bytes, { password })` が**材料化の時点で復号する**。
オブジェクトストリームの中まで 1 パスで読める（コーパスの暗号化 4 検体で
`getObject` 全件 + `getCatalog` 成功を実測済み・normativepdf CHANGELOG 0.8.0）。

**したがってこのファイルは撤去できる見込みがある。** ただし前提が 1 つあり、これは実測項目である:

> `pdfua-validator` が求める「暗号化オブジェクトストリームの中の構造木」が、
> 1 パスの `parsePdf({password})` で見えること

加えて 0.8.0 は「復号器なしで `/Encrypt` を持つ文書の `getObject` は名指しでエラー」にしており、
暗号文を平文の顔で返す経路が閉じている。これは 2026-08-24 の通し実走で記録した
「暗号化 PDF の扱いが 3 通り」の不整合を解消する側に働く。

## 5. 段取り

### L0. ゴールデン採取 — **撤去前に固定する（後から作れない）**

ADR-0006（writer Phase 3）と同じ型。pdf-lib が在るうちに、7 ツールの出力を凍結する。

- 対象ツール: `validate_conformance` / `evaluate_policy` / `verify_integrity` /
  `verify_signatures` / `detect_pades_level` / `identify_conformance` / `validate_clauses`
- 検体の軸（1 形しか無い軸を毎回報告させる）:
  素の PDF / タグ付き / PDF/A-1b・2b・3b・4 / **暗号化 4 方式（RC4 V2R3・AESV2 ×2・AESV3）** /
  署名（PAdES B-B〜B-LTA・DocTimeStamp）/ 増分更新あり / 壊れた xref / `origin > 0`
- 🔴 **計器そのものに T-3 を通してから採る。** writer の Phase 3 では、ページ参照を
  `{"@page": i}` に畳んでいたためページの中身がダイジェストに 1 バイトも入っていなかった。
  ゴールデンの 1 項目を書き換えて A/B が差を報告することを先に実測する

### L1. normativepdf `0.2.0 → 0.8.0`

- いま使っているのは `revision-diff.ts` の 4 記号のみ
  （`dictGet` / `readXrefSectionAt` / `XrefEntry` / `XrefSection`）。4 記号とも 0.8.0 に存在する
- ⚠️ **normativepdf の CHANGELOG は 0.7.0 以降しか記載が無い。**
  0.2.0 → 0.6.x の間の変更は記録から追えないので、**`dist/index.d.ts` の差分で確認する**
- 受入: `npm test` 全緑・`corpus` 相当の回帰なし

### L2. `pdf-parser.ts`（24 lookup）

他 4 ファイルの入口。`loadPdfDocument` の戻り型を `PdfDocument` に替える。
ここで `parsePdf({password})` を通すかどうかが L4 の可否を決める。

### L3. `pdfa-validator.ts` + `pdfua-validator.ts`（41 lookup・async 化）

- §3 のとおり 2 本を async にし、呼び出し側に `await` を 2 つ足す
- `decodeText()` の置き換えが要る（未決 1）
- `getPages()` 2 箇所 → `readPageTree`

### L4. `decrypt-document.ts` の撤去可否を実測 → 撤去 or 縮小

### L5. `conformance-validation.ts`（3 lookup）+ `package.json` の `pdf-lib` を `devDependencies` へ

テスト側 4 ファイル（`validate-clauses.test.ts` 148 行 / `validate-pdfua.test.ts` 185 行 /
`evaluate-policy.test.ts` 451 行 / `helpers/ua-pdf.ts` 116 行）は **pdf-lib のまま残す**。
writer の `tests/helpers/pdf-lib-reader.ts` と同じ位置づけ（ADR-0004「二面で測る」・GUARDS T-2）。
撤去後は verify も normativepdf の上に乗るので、自分が書いたものを自分で読み戻す形になってしまう。

---

## 6. 受入基準（3 面・着手前に決める）

### 面 1 — 撤去

`grep -rl "from 'pdf-lib'" src/` が **5 → 0**、`package.json` の `dependencies` から
`pdf-lib` が消える（`devDependencies` には残る）。

🔴 **`npm ls pdf-lib` で依存ツリーからも消えること。**
`@shuji-bonji/pdf-constraints` 0.3.0 が `dependencies` に `pdf-lib: ^1.17.1` を持っているので、
**B1 が済んでその版を取り込むまで、この条件は満たせない**（実測 2026-08-27）:

```
pdf-verify-mcp
  ├─ pdf-lib ^1.17.1                    ← 本作業で消す
  └─ @shuji-bonji/pdf-constraints 0.3.0
       └─ pdf-lib ^1.17.1               ← B1 で消す
```

### 面 2 — 出力の A/B

L0 のゴールデンと差 0。**差が出たら、1 件ずつ「是正」か「後退」かを帰属させる。**

予測される差が 1 種類ある。normativepdf は §7.5.4 を条文どおり厳格に読み、回復方針は
消費者側に置く設計（normativepdf `DESIGN.md` §4.2）なので、**壊れた xref の検体が
「歩けた」から「判定不能」へ落ちる**。2026-08-13 の `revision-diff.ts` 移行の A/B 実測では
PDF 2,987 件中 6 件が該当した（内訳: `xref` が行独立でない 3 / subsection ヘッダが数値でない 1 /
エントリが 19 バイト 1 / xref でも xref ストリームでもない 1）。

**落ちる向きは常に `indeterminate` 側で、誤った `pass` は生まない。** これを受入の条件として
明文化する: **A/B の差のうち `pass → 非 pass` は 0 件、`歩けた → 判定不能` は帰属付きで許容**。

### 面 3 — 独立オラクル

**veraPDF の判定が移行前後で同一。** 撤去後は family 内のパーサが全部 normativepdf の上に乗るので、
family 内のものはオラクルになれない（GUARDS T-2）。verify は veraPDF を権威エンジンとして
既に持っているので、そのまま独立オラクルとして使える。qpdf も併用する。

### T-3 — 検査が本当に落ちるか（3 通り以上を実測）

1. 復号を外す → 暗号化検体のテストが落ちる
2. `await` を 1 つ落とす → Promise が値として比較され、該当検体が落ちる
3. ゴールデンの 1 項目を書き換える → A/B が差を報告する（L0 で先に実測済みのものを再確認）

---

## 7. 未決

### 未決 1 — §7.9.2 テキスト文字列復号の置き場所 → **決着（2026-08-27）: normativepdf に足す**

前段 N として起票済み（`lib/normativepdf/docs/handoff/text-string-and-date.md`）。
消費者が 4 つ（reader / verify / pdf-constraints / writer の書き側）あり、
第 1 消費者は pdf-constraints。以下は決着の根拠として残す。


`PDFString#decodeText()` / `PDFHexString#decodeText()` の代替が要る。
規格側の要求は 4 行（pdf-spec-mcp `get_requirements` §7.9.2 で実測）:

| 規則 | 内容 |
|---|---|
| `R-7.9.2.2.1-2` | PDFDocEncoding / UTF-16BE / UTF-8（PDF 2.0）のいずれか |
| `R-7.9.2.2.1-3` | UTF-16BE は先頭 `FE FF` |
| `R-7.9.2.2.1-4` | UTF-8 は先頭 `EF BB BF` |
| `R-7.9.2.2.2-3` | 言語エスケープ列の除去 |

選択肢:

- **A: normativepdf の公開面に足す。** 条文つきで置く。reader も後で同じものが要る
  （reader は `content-stream-service.ts:155` に `decodeTextString` を自前で持っており、
  pdf-lib からは変換テーブル 2 本を借りているだけ。しかも **UTF-8 BOM は pdf-lib 1.x が
  扱わないので reader が自分で足している** = pdf-lib は `R-7.9.2.2.1-4` を満たしていない）
- **B: verify 側に置く。** normativepdf に要求を立てない。reader 移行時に二重実装になる

**A を推す。** 理由は、消費者が 2 つあり、既存の実装（reader）が pdf-lib より条文に近いこと。
normativepdf の要求駆動の型（「要求はすべて第 1 消費者から立った」）にも合う。
その場合 normativepdf を先に上げてから verify が消費する順になり、L3 の前に 1 リリース挟まる。

### 未決 2 — `revision-diff.ts` に残した回復方針の扱い

`revision-diff.ts` は 0.2.0 移行時に、回復方針（古い startxref への後退・`MAX_REVISIONS`・
巡回検出・linearized の嘘対策）を verify 側に温存した。L2 で `pdf-parser.ts` も normativepdf に
載せると、**同じ種類の回復コードが 2 か所に出る**。1 か所に寄せるかは L2 の実装時に決める。

## 8. 測らないと決めること

- **性能。** normativepdf は async、pdf-lib は同期。速度は受入に入れない
- **reader との共通化。** COS 対応層を共有ライブラリに切り出すかは、reader 移行の起票時に決める。
  ここで先回りして作らない（writer Phase 2 で「pdf-lib → COS の変換層は作らない」と決めたのと同じ理由）
- **veraPDF が見ていない面。** フォント埋め込み・色空間・透明度・読み上げ順序は、
  移行前後どちらでも measured ではない
- **TypeScript / `@types/node` の版の影響。** 本作業に入る時点で TS 7.0.2 + `@types/node ^22` に
  揃っている前提で測る（issue-draft-08 の決定）。`@types/node` 26 は pkijs の `CryptoEngine` が
  WebCrypto の `ICryptoEngine`（`decapsulateBits` / `decapsulateKey` / `encapsulateBits` /
  `encapsulateKey`）を実装しておらず `cms-verifier.ts:31` で 1 件出る。**これは TypeScript の版とは
  独立**（TS 5.9 でも 7.0 でも同じ 1 件・2026-08-27 に 2×2 で実測）
