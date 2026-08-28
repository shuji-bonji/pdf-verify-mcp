# 引き継ぎ: pdf-verify-mcp の pdf-lib 撤去（normativepdf 0.9.0 へ）

- 対象リポジトリ: `pdf-verify-mcp`（この文書のある repo）
- 起票: 2026-08-27
- **family の pdf-lib 撤去の第 2 弾**。第 1 弾は writer（Phase 3・2026-08-18 受入充足）。
  reader は第 3 弾として別に起こす（normativepdf `docs/ROADMAP.md` Phase 1 の未チェック項目
  「reader から使わせる（第 2 消費者）」）
- **これはトラック B の第 3 段（B2）。前段 2 つは 2026-08-28 に完了した:**
  1. **N** = normativepdf の §7.9 文字列層 → **0.9.0 として npm 公開済み**。
     `decodeTextString` / `parsePdfDate` / `formatPdfDate` がある
  2. **B1** = pdf-constraints の pdf-lib 撤去 → **0.4.0 として npm 公開済み**（受入 3 面充足）。
     ✅ **本作業の受入面 1 の前提はこれで解けた**（§6 面 1）。
     B1 でやったことと踏んだ穴は §9 にまとめてある —— **着手前に §9 を読むこと**
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

`grep -rl "from 'pdf-lib'" src/` = **6 ファイル**（2026-08-28 再実測。下の表の 5 つに
`services/revision-diff.ts` を足した 6 つ。0.2.0 移行で歩行層は normativepdf に載せたが、
`import` は残っている）。
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

| pdf-lib | normativepdf 0.9.0 | 備考 |
|---|---|---|
| `PDFDict` / `PDFArray` / `PDFName` / `PDFNumber` / `PDFString` / `PDFHexString` / `PDFBool` / `PDFRef` / `PDFRawStream` | `CosDict` / `CosArray` / `CosName` / `CosInteger`・`CosReal` / `CosString` / `CosBoolean` / `CosRef` / `CosStream` | `dictGet` / `dictGetRaw` で引く |
| `PDFDocument.load(bytes)` | `parsePdf(bytes, { password })` | **復号込み**（§7.6.2 の例外 4 種を実装済み） |
| `doc.context.lookup(...)` | `await doc.resolve(...)` / `await doc.getObject(n, g)` | **async になる** |
| `doc.catalog` | `await doc.getCatalog()` | |
| `doc.getPages()` | `readPageTree` / `PageEntry` / `inheritedAttribute` | 継承の解決つき（§7.7.3.4） |
| `decodePDFRawStream` | `decodeStream` | 自前 inflate（RFC 1950/1951）+ Predictor 全 5 タグ |
| `PDFName#decodeText()` | `CosName.value` | `#xx` 解決と UTF-8 復号は lexer が済ませている（R-7.3.5-13） |
| `PDFObjectParser` / `PDFObjectStreamParser` / `PDFWriter` | `parseObject` / `loadObjectStream` / `writeFile` | `decrypt-document.ts` のみ |
| **`PDFString#decodeText()` / `PDFHexString#decodeText()`** | **`decodeTextString(bytes)`**（0.9.0） | 未決 1 は決着。§7 |

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
  署名（PAdES B-B〜B-LTA・DocTimeStamp）/ 増分更新あり / 壊れた xref / `origin > 0` /
  🔴 **PDF 2.0 の例**（`lib/normativepdf/corpus/pdf20examples` 7 件）—— B1 では
  この軸を入れ忘れて、変更が動かすと予測した差が 1 件も出なかった（§9.4）
- 🔴 **計器そのものに T-3 を通してから採る。** writer の Phase 3 では、ページ参照を
  `{"@page": i}` に畳んでいたためページの中身がダイジェストに 1 バイトも入っていなかった。
  ゴールデンの 1 項目を書き換えて A/B が差を報告することを先に実測する

### L1. normativepdf `0.2.0 → 0.9.0`

- いま使っているのは `revision-diff.ts` の 4 記号のみ
  （`dictGet` / `readXrefSectionAt` / `XrefEntry` / `XrefSection`）。4 記号とも 0.8.0 に存在する
- ⚠️ **normativepdf の CHANGELOG は 0.7.0 以降しか記載が無い。**
  0.2.0 → 0.6.x の間の変更は記録から追えないので、**`dist/index.d.ts` の差分で確認する**
- 受入: `npm test` 全緑・`corpus` 相当の回帰なし

> 🔴 **L2 と L3 は 1 つの段として計画すること**（B1 で実測。§9.1）。
> 入口の戻り型を替えた瞬間に 2 つの validator が動くので、分けても分けたことにならない。

### L2 + L3. `pdf-parser.ts`（24 lookup）

他 4 ファイルの入口。`loadPdfDocument` の戻り型を `PdfDocument` に替える。
ここで `parsePdf({password})` を通すかどうかが L4 の可否を決める。

#### （L3 として計画していた分）`pdfa-validator.ts` + `pdfua-validator.ts`（41 lookup・async 化）

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

✅ **前提は解けた（2026-08-28）。** `@shuji-bonji/pdf-constraints` **0.4.0** は
`dependencies` が `normativepdf` だけになり、`npm ls pdf-lib` は `(empty)` を返す。
この repo が 0.4.0 を取り込めば、残るのは自分の `pdf-lib` 1 つだけになる。

```
pdf-verify-mcp
  ├─ pdf-lib ^1.17.1                    ← 本作業で消す（残るのはこれだけ）
  └─ @shuji-bonji/pdf-constraints 0.4.0
       └─ normativepdf 0.9.0            ← B1 で入れ替わった
```

⚠️ **0.4.0 の取り込みは破壊的変更を含む。** `collectSubjects` / `extractors` /
`FactExtractor` の export が消えた（この repo は `checkFile` と `listTables` しか
使っていないので影響しないことを実測済み）。`CheckReport` に `observation` が増えた。
`validate_clauses` の出力にそれを載せるかは、L5 で決める。

### 面 2 — 出力の A/B

L0 のゴールデンと差 0。**差が出たら、1 件ずつ「是正」か「後退」かを帰属させる。**

予測される差が 1 種類ある。normativepdf は §7.5.4 を条文どおり厳格に読み、回復方針は
消費者側に置く設計（normativepdf `DESIGN.md` §4.2）なので、**壊れた xref の検体が
「歩けた」から「判定不能」へ落ちる**。2026-08-13 の `revision-diff.ts` 移行の A/B 実測では
PDF 2,987 件中 6 件が該当した（内訳: `xref` が行独立でない 3 / subsection ヘッダが数値でない 1 /
エントリが 19 バイト 1 / xref でも xref ストリームでもない 1）。

**落ちる向きは常に `indeterminate` 側で、誤った `pass` は生まない。** これを受入の条件として
明文化する: **A/B の差のうち `pass → 非 pass` は 0 件、`歩けた → 判定不能` は帰属付きで許容**。

**B1 の実測を受けた追記（2026-08-28）。** 上の 2 分類では足りなかった。B1 では
「判定が変わった」のではなく「**読めた範囲が変わった**」差が 2 種類出て、どちらも
帰属できたが、受入の文言が無いと止まる。

| 差 | 受入 | 条件 |
|---|---|---|
| **読めた → 読めない**（文書ごと） | 帰属付きで許容 | エラーが**条文を名指ししていること**。B1 では 14 件で、全部 veraPDF の *fail* 検体だった（§7.5.4 の xref・§7.5.2 のヘッダ・§7.7.2 の catalog `/Version`） |
| **観測できた対象が減った**（`verify_integrity` の revisions、`pdfua-validator` の構造要素など） | 帰属付きで許容 | **どこまで読めたかを出力が申告していること**。申告が無いまま減るのは見逃しで、許容しない |

🔴 **最も危険な差は「反証できなくなった」形である。** B1 では `fail → not_applicable` が
それに当たり、実際に 1 件踏んだ。verify では **`fail` / `indeterminate` → `pass`** と
**規則の適用数が減ること**が同じ形になる。`validate_conformance` の
「146 / 146」のような数が減っていないかを毎回見る。

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

## 9. B1 の実測（2026-08-28）—— ここから持ってくるもの

B1（`@shuji-bonji/pdf-constraints` 0.3.0 → **0.4.0**）が受入 3 面とも充足して終わった。
同じ形が verify でもそのまま要る。**着手前にこの節を読むこと。**
一次資料は `lib/pdf-constraints/docs/handoff/pdflib-removal.md`。

### 9.1 L2 と L3 は切り離せない（B1 で実測）

B1 の計画も「入口（L2）→ 抽出器（L3）」と分けていたが、**分けられなかった**。
入口を `parsePdf` に替えると、そこから流れる `doc` の型が消費側すべてに当たる。
入口だけ替えて中を pdf-lib のままにするには**同じファイルを 2 つのパーサで読む**しかなく、
それは測る対象を 2 つにする。

verify も同じ形になる。`pdf-parser.ts`（L2）の `loadPdfDocument` の戻り型を替えた瞬間に
`pdfa-validator.ts` / `pdfua-validator.ts`（L3）が動く。**L2 と L3 は 1 つの段として計画する。**
`decrypt-document.ts`（L4）と `conformance-validation.ts`（L5）は後ろに残せる。

### 9.2 そのまま持ってくる 4 つ

1. **COS の読み口を 1 ファイルに集める。** B1 は `src/facts/cos.ts`（120 行）に
   `instanceof` と `context.lookup` の置き換えを集めた（`asDict` / `asStream` / `nameOf` /
   `textOf` / `numbersOf` / `has` / `refKey` / `decodedBytes`）。**ここに判定を書かない。**
   6 ファイルに散らすと同じ変換が 6 通りになる
2. **「観測できなかった」を「違反」にしない。** B1 は条文違反で受け取れないストリームで
   facts が初期値 `null` のまま制約に食われ、`pass → fail` を 2 件出した。
   verify では **`indeterminate` に落とす**のが対応物で、`pass` にも `fail` にも倒さない
3. **「読めなかった」と「そこに無い」を分ける。** B1 は `tryLookup(doc, value)` が
   `{ value, unreadable }` を返す形にした。**未定義の間接参照は null と等価**
   （R-7.3.10-13）で、それは**観測できた事実**である。2 つを同じ `undefined` に畳むと、
   「フォントが埋め込まれていない」と「フォントを読めなかった」が同じ顔になる
   （B1 で一度そうして、唯一 fail していた検体を消した）
4. **どこまで読めたかを出力に載せる。** B1 は `CheckReport.observation`
   （`xrefChain` / `objects` / `pagesReached` / `pages`）を足した。**判定ではなく判定の射程。**
   `/Prev 0` で打ち切られた検体で subject が 10 → 1 になったのに、`results` は
   「違反なし」の顔をしていた。verify は `verify_integrity` の `revisionChain` で
   同じことを既にやっているので、**それを他の 6 ツールにも広げる**形になる

### 9.3 ゴールデンの計器（L0）

B1 は `lib/pdf-constraints/scripts/golden.mjs`（532 行）を書いた。verify 用に作り直すが、
設計はそのまま使える。

- **凍結するのは要約ではなく中身。** 検体ごとに、ツールの出力を項目単位で持つ。
  `verdict` の 1 語だけを凍結すると、判定を動かさない変化が写らない
- **読めなかったファイルは落とさず `error` として記録する。** 暗号化検体はここに出る
- **版はヘッダでだけ比べる。** 全検体が差になると判定の差が埋もれる
- **`t3` モードで計器自身を壊して差が出るかを実測する**（B1 は 9 通り + 空振り検査）。
  [[instrument-must-pass-t3]]
- **`take` は毎回「1 形しか無い軸」と「一度も fail しない規則」を印字する。**
  🔴 **B1 の後退を捕まえたのはこの申告だった**（判定の A/B ではない）

### 9.4 検体の集合

🔴 **`fixtures` と veraPDF コーパスだけでは足りない。** B1 は最初その 2 つで採り、
**変更が動かすと予測した軸（UTF-8 BOM）を持つ検体が 1 件も無かった**。
`corpus/pdf20examples`（PDF 2.0 の例 7 件）と `corpus/_wout`（往復出力 3 件）を足して
2,931 検体にしたら差が出た。verify の検体軸（§5 L0）に **PDF 2.0 の例**を足すこと。

`--set` のようなフラグは 1 つずつ直接書く（**zsh は引用符なしの変数展開を単語分割しない**。
B1 で `$SETS` が 1 個の引数として届き、既定の 14 件で「採れた」顔のゴールデンが出た）。

### 9.5 pdf-lib 側の取りこぼし 2 件（verify にも効く）

B1 の A/B で、**pdf-lib が読み落としていたもの**が 2 つ出た。verify の判定にも効く。

1. **UTF-8 のバイト順マーク付きテキスト文字列**（R-7.9.2.2.1-4・PDF 2.0）を pdf-lib 1.x は
   扱わない。`EF BB BF` で始まる `/CreationDate` が `ï»¿D:...` になり、**適合している文書に
   「日付が文法に合わない」と 2 件の違反を報告していた**。`pdfua-validator.ts` は
   `/Lang` `/Alt` `/Title` を読むので、同じことが起きうる
2. **ハイブリッド文書（`XRefStm`）のトレーラ `/Info`** を pdf-lib は鍵を持ちながら値を
   `undefined` で落としていた。`validate_conformance` の metadata 系がこれに当たる

### 9.6 環境

- **サンドボックス（device_bash）ではビルドもテストも回せない**（TypeScript 7 の実行ファイルが
  macOS 用）。`dist` があれば計器と probe は動く（normativepdf は純 JS）
- 判定を凍結する計器と、事実を突き合わせる probe は**別物で、両方要る**。
  「差 0 件」は「判定が変わらなかった」であって「何も変わらなかった」ではない
  = [[zero-diff-can-mean-the-axis-is-absent]]
