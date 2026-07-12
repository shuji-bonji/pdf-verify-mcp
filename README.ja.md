# pdf-verify-mcp

[English](./README.md)

PDF の**真正性検証**に特化した MCP サーバ — 電子署名の暗号学的検証、改ざん検知、PAdES ベースラインレベル判定、PDF/A・PDF/UA 宣言の識別を行います。

[pdf-reader-mcp](https://github.com/shuji-bonji/pdf-reader-mcp)（構造解析）、[pdf-spec-mcp](https://github.com/shuji-bonji/pdf-spec-mcp)（仕様参照）と同じ PDF family の一員です。`pdf-reader-mcp` が「何があるか」を読むのに対し、`pdf-verify-mcp` は「それが本物か」を検証します。

## ツール

| ツール | 役割 |
|--------|------|
| `verify_signatures` | 暗号学的検証＋トラストアンカーによるチェーン信頼評価＋失効確認（埋め込み OCSP/CRL またはオンライン照会）＋RFC 3161 タイムスタンプ検証 |
| `verify_integrity` | 改ざん検知: 増分更新、署名後の変更、DocMDP（証明署名）の権限違反 |
| `detect_pades_level` | PAdES ベースラインレベル（B-B / B-T / B-LT / B-LTA）判定（LTV データの内容検証付き） |
| `identify_conformance` | XMP メタデータ上の PDF/A・PDF/UA 準拠宣言の識別 |

## 判定（verdict）

| verdict | 意味 |
|---------|------|
| `valid` | ByteRange ダイジェストが一致し、CMS 署名が暗号学的に有効 |
| `invalid` | ダイジェスト不一致または署名検証失敗（改ざんの疑い） |
| `indeterminate` | 未対応形式、または検証を完了できなかった |

## 信頼評価と失効確認（v0.2）

`trust_anchors`（PEM/DER ファイルパス配列）を渡すか、環境変数 `PDF_VERIFY_TRUST_ANCHORS`（証明書ディレクトリ）を設定すると、署名者のチェーンを評価します。結果は `trusted` / `untrusted` / `not_evaluated` と証明書パスで報告され、検証基準時刻は署名時刻です。

`check_revocation` で失効確認を制御します: `embedded`（デフォルト — PDF の DSS や CMS 内の OCSP/CRL）、`online`（さらに OCSP レスポンダ・CRL 配布点へ HTTP 照会）、`none`。署名者証明書が失効している場合、verdict は `invalid` になります。

> トラストアンカー未指定時は `trust: not_evaluated` のままです。その場合の `valid` は「暗号学的な完全性」であり、署名者の身元保証ではありません。

対応 SubFilter: `ETSI.CAdES.detached`（PAdES）、`adbe.pkcs7.detached`、`ETSI.RFC3161`。RFC 3161 タイムスタンプは imprint 照合＋TSA 署名まで完全検証します。レガシー MD5/SHA-1 署名は node:crypto で検証し、弱アルゴリズムとして注記します。

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
