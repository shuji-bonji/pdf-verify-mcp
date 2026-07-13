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
| `validate_conformance` | PDF/A 準拠検証（ISO 19005）: veraPDF があれば委譲、なければ内蔵ルールサブセット |

## 判定（verdict）

| verdict | 意味 |
|---------|------|
| `valid` | ByteRange ダイジェストが一致し、CMS 署名が暗号学的に有効 |
| `invalid` | ダイジェスト不一致または署名検証失敗（改ざんの疑い） |
| `indeterminate` | 未対応形式、または検証を完了できなかった |

## 信頼評価と失効確認（v0.2）

`trust_anchors`（PEM/DER ファイルパス配列）を渡すか、環境変数 `PDF_VERIFY_TRUST_ANCHORS`（証明書ディレクトリ）を設定すると、署名者のチェーンを評価します。結果は `trusted` / `untrusted` / `not_evaluated` と証明書パスで報告され、検証基準時刻は署名時刻です。

`check_revocation` で失効確認を制御します: `embedded`（デフォルト — PDF の DSS や CMS 内の OCSP/CRL）、`online`（さらに OCSP レスポンダ・CRL 配布点へ HTTP 照会）、`none`。署名者証明書が失効している場合、verdict は `invalid` になります。online モードでは、発行者証明書が未同梱の場合に AIA caIssuers から取得してチェーンを補完します（v0.4）。アンカー指定時は RFC 3161 タイムスタンプの TSA 証明書チェーンも評価します（`tsaTrust`）。

> トラストアンカー未指定時は `trust: not_evaluated` のままです。その場合の `valid` は「暗号学的な完全性」であり、署名者の身元保証ではありません。

暗号化PDFは、権限制御型（user password 空）なら自動復号します。閲覧パスワード型は `password` を渡してください。対応: RC4（R2–R4）、AES-128、AES-256（R6）。復号により文字列メタデータ（フィールド名・/M・/Reason・/Location）と XMP を復元します。署名の `/Contents` は暗号化対象外なので、検証は復号の成否に依存しません。

対応 SubFilter: `ETSI.CAdES.detached`（PAdES）、`adbe.pkcs7.detached`、`ETSI.RFC3161`。RFC 3161 タイムスタンプは imprint 照合＋TSA 署名まで完全検証します。レガシー MD5/SHA-1 署名は node:crypto で検証し、弱アルゴリズムとして注記します。

## PDF/A 準拠検証（v0.3）

`validate_conformance` はハイブリッドエンジンです。veraPDF がインストール済み（`PDF_VERIFY_VERAPDF` 環境変数 or PATH）なら委譲して正式な判定を得ます。未導入なら内蔵の主要ルールサブセット（約15ルール: 暗号化・trailer /ID・LZW・フォント埋め込み・JavaScript/禁止アクション・OutputIntent・A-1 の透明性・XFA 等）をネイティブ実行し、各違反に ISO 19005 の条項参照を付けて報告します。

ネイティブ判定の限界は明示します: 違反検出=確定的な不適合、全ルール通過=「チェック範囲内で違反なし」であり適合証明ではありません。PDF/UA（アクセシビリティ）検証は pdf-reader-mcp の `validate_tagged` の担当です。

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
