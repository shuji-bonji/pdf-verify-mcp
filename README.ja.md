# pdf-verify-mcp

[English](./README.md)

PDF の**真正性検証**に特化した MCP サーバ — 電子署名の暗号学的検証、改ざん検知、PAdES ベースラインレベル判定、PDF/A・PDF/UA 宣言の識別を行います。

[pdf-reader-mcp](https://github.com/shuji-bonji/pdf-reader-mcp)（構造解析）、[pdf-spec-mcp](https://github.com/shuji-bonji/pdf-spec-mcp)（仕様参照）と同じ PDF family の一員です。`pdf-reader-mcp` が「何があるか」を読むのに対し、`pdf-verify-mcp` は「それが本物か」を検証します。

## ツール

| ツール | 役割 |
|--------|------|
| `verify_signatures` | 電子署名の暗号学的検証: ByteRange ダイジェストと CMS messageDigest の照合、PKCS#7/CMS 署名検証、証明書サマリ |
| `verify_integrity` | 改ざん検知: 増分更新、署名後の変更、DocMDP（証明署名）の権限違反 |
| `detect_pades_level` | PAdES ベースラインレベル（B-B / B-T / B-LT / B-LTA）の構造判定 |
| `identify_conformance` | XMP メタデータ上の PDF/A・PDF/UA 準拠宣言の識別 |

## 判定（verdict）

| verdict | 意味 |
|---------|------|
| `valid` | ByteRange ダイジェストが一致し、CMS 署名が暗号学的に有効 |
| `invalid` | ダイジェスト不一致または署名検証失敗（改ざんの疑い） |
| `indeterminate` | 未対応形式、または検証を完了できなかった |

> **重要（v0.1 の範囲）:** 証明書チェーンのトラストアンカー評価は行いません。すべての結果に `trust: 'not_evaluated'` が付きます。`valid` は「暗号学的な完全性」を意味し、署名者の身元保証ではありません。トラストアンカー対応は v0.2 で予定しています（[docs/PROJECT_PLAN.md](./docs/PROJECT_PLAN.md) 参照）。

対応 SubFilter: `ETSI.CAdES.detached`（PAdES）、`adbe.pkcs7.detached`、`ETSI.RFC3161`（文書タイムスタンプ、imprint 照合）。

## インストール

```json
{
  "mcpServers": {
    "pdf-verify": {
      "command": "npx",
      "args": ["-y", "@shuji-bonji/pdf-verify-mcp"]
    }
  }
}
```

## 使用例

- 「/path/to/契約書.pdf の署名を検証して。署名後に改変されていない？」
- 「この証明署名付き PDF は認証後に変更された？」
- 「この署名は LTV 対応（B-LT / B-LTA）になっている？」
- 「この文書は PDF/A-2b を宣言している？」

## 開発

```bash
npm install
npm test               # vitest（フィクスチャはメモリ上で生成）
npm run build
npm run check          # biome lint + format
npm run test:fixtures  # 署名済み/改ざん済みサンプル PDF を tests/fixtures/generated/ に出力
```

テストフィクスチャ（自己署名証明書＋署名済み PDF）は pkijs + WebCrypto でプログラム生成します。リポジトリにバイナリ資産は持ちません。

## ライセンス

MIT © shuji-bonji

依存: pkijs / asn1js（BSD-3-Clause）、pdf-lib（MIT）、@modelcontextprotocol/sdk（MIT）、zod（MIT）。
