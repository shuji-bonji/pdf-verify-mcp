# pdf-verify-mcp - 開発ガイド

## プロジェクト概要

PDF の**真正性・準拠性**を判定する MCP サーバ。PDF family における「**判定**」担当。

| 層 | サーバ | 一行定義 |
|----|--------|----------|
| 正典 | [pdf-spec-mcp](https://github.com/shuji-bonji/pdf-spec-mcp) | 仕様は何を要求するか |
| 実体 | [pdf-reader-mcp](https://github.com/shuji-bonji/pdf-reader-mcp) | 中身に何があるか（**合否は言わない**） |
| **判定** | **本サーバ** | **それは本物で、規格に適っているか** |
| 生成 | [pdf-writer-mcp](https://github.com/shuji-bonji/pdf-writer-mcp) | 仕様どおりに書けるか |

- 責務分担の提案: `mcps/pdf-family-role-architecture.md`
- 上位仕様: `Document-Note/mcps/PDFfamily/specs/01-pdf-verify-mcp.md`
  ⚠️ **名称衝突に注意**: specs/01 の主題は「AI 抽出結果と原本の照合」で**未実装**。
  本リポジトリの実装は「原本の真正性検証」であり、別スコープ（specs/00 付記 6 参照）

## ツール一覧

| ツール | 説明 |
|--------|------|
| `verify_signatures` | 暗号学的検証・信頼チェーン評価・失効確認（OCSP/CRL）・RFC 3161 タイムスタンプ |
| `verify_integrity` | 改ざん検知（増分更新・署名後の変更・DocMDP 違反） |
| `detect_pades_level` | PAdES ベースライン（B-B / B-T / B-LT / B-LTA） |
| `identify_conformance` | XMP 上の PDF/A・PDF/UA **宣言**の識別（判定はしない） |
| `validate_conformance` | PDF/A（ISO 19005）・PDF/UA（ISO 14289）の**準拠判定** |

## 境界ルール（ツール追加時の判断基準）

> **ISO 規格等に照らした compliant / valid / pass-fail を返すなら本サーバ、
> 観測結果を返すだけなら pdf-reader-mcp。**

- `identify_conformance`（宣言を読むだけ）が本サーバにあるのは、判定の入口だから
- reader の `inspect_signatures`（署名フィールドの存在＝事実）と
  本サーバの `verify_signatures`（暗号検証＝判定）の棲み分けはこの規則どおり
- v0.6 で PDF/UA 判定を reader の `validate_tagged` から移管したのも同じ理由
  （reader は構造ツリーを**報告**する、本サーバが**判定**する）

## アーキテクチャの要点

```
index.ts（stdout-guard を最初に import）→ tools/index.ts で全ツール登録
  各 tools/*.ts : zod スキーマ + ハンドラ（parse → service → format → truncate）
  services/     : 判定ロジック本体
  utils/        : formatter（markdown 化）・error-handler・logger
```

- ツール追加は `tools/xxx.ts` を作り `tools/index.ts` の `registerAllTools` に 1 行
- 依存は軽量に保つ（`pkijs` / `asn1js` / `pdf-lib` / `zod` のみ）。
  **pdfjs は入れない** — reader の領分であり、判定に必要な範囲は pdf-lib で足りる

## 落とし穴（知らないと壊すもの）

### 1. `stdout-guard.ts` は必ず最初の import

MCP は stdout で JSON-RPC を話すため、依存ライブラリの `console.log` 1 つで通信が壊れる。
ESM は import を巻き上げるので、**index.ts に直書きしても手遅れ**（依存モジュールの評価が先に走る）。
副作用専用モジュールとして切り出し、**他のどの import よりも先**に置くこと。この順序を崩さない。

### 2. veraPDF があるときは委譲する（native は保険）

`validate_conformance` はハイブリッド。veraPDF（`PDF_VERIFY_VERAPDF` or PATH）があれば委譲し、
無ければ内蔵ルールを走らせる。**内蔵ルールは意図的なサブセット**であり、
「全部通った ＝ 適合」ではない。この非対称性は `compliant` の型に表れている。

| engine | compliant |
|--------|-----------|
| verapdf | `true` / `false`（確定） |
| native | `false`（違反あり＝確定）／ **`null`**（チェック範囲内で違反なし＝**適合証明ではない**） |

**`null` を `true` に丸めてはいけない。** 正直さがこのサーバの価値。

### 3. native ルールは pdf-lib で届く範囲に限定する

PDF/UA でコンテンツストリーム解析が要る要件（7.1-3 コンテンツの Artifact/タグ付け、
7.2-34 ページ内容の自然言語、7.18.1-1 注釈の Annot タグ内包、7.18.3-1 `/Tabs`）は
**近似せず veraPDF に委ねる**。中途半端な近似は誤判定を生み、判定サーバとしての信頼を損なう。

実測（2026-07-16・writer v0.4.0 の出力）: veraPDF ua1 は 106 規則で 10 違反、
native 12 規則はそのうち 6 件を検出。**native の指摘は veraPDF と矛盾しなかった**が、
上記 4 項目は native では届かない。

### 4. PDF/UA には severity がある（PDF/A には無い）

アクセシビリティは機械で判定しきれない（alt テキストが**あるか**は検査できるが**適切か**は不能）。
そのため PDF/UA のネイティブ規則のみ `severity: 'error' | 'warning'` を持ち、
**`error` だけが `compliant: false` を確定させる**。`warning` は人間の確認対象。

### 5. flavour の自動選択は PDF/A 優先

PDF/A-2a + PDF/UA-1 の両方を宣言する文書は実運用で頻出する。
flavour 未指定時は **PDF/A を優先**し（後方互換）、PDF/UA を宣言していれば notes で `pdfua-1` を案内する。
PDF/UA を自動選択するのは「PDF/UA を宣言し、かつ PDF/A を宣言していない」場合のみ。

### 6. reader に依存しない

実装版 verify は pdf-reader-mcp 非依存（specs/00 の Pattern A は不採用）。
この独立性が A2A 時代の生存戦略であり、北極星（PDF 専門 LLM）における
**テストオラクルとしての信頼性の根拠**でもある。安易に依存を足さない。

## テスト

```bash
npm test              # vitest（60 件）
npm run typecheck
npm run check         # biome（lint + format）
```

- fixture は `tests/helpers/signed-pdf.ts` のビルダで組む（`createSignedPdf(identity, {...})`）。
  XMP は `{ xmp: { pdfaPart, pdfaConformance, pdfuaPart } }` で宣言を注入できる
- PDF/UA のテスト（`validate-pdfua.test.ts`）は pdf-lib で構造木ごと組み立て、
  **欠陥を 1 つずつ注入して規則を特定**する形にしている
- veraPDF 依存のテストは書かない（CI に veraPDF が無いため）。engine は `native` で固定する

## リリース

1. `package.json` の version を上げる
2. `CHANGELOG.md` に追記（英語）
3. コミット → push
4. `git tag vX.Y.Z && git push origin vX.Y.Z` → `publish.yml` が Trusted Publisher (OIDC) で公開

タグと version が一致しないと publish workflow が停止する。

## ドキュメント方針

- `README.md` = **英語**（メイン）、`README.ja.md` = 日本語。両者を同時に更新する
- `CHANGELOG.md` = 英語。判定の変更は**何を検出できるようになったか / 何は依然できないか**を書く
- 判定の限界を隠さない。「できないこと」の明示がこのサーバの信頼性そのもの
