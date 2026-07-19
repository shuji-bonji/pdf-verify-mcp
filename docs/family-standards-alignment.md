# family 共通実装規約への整合 — pdf-verify-mcp

**作成日**: 2026-07-17
**規約本体**: `Document-Note/mcps/PDFfamily/specs/06-family-implementation-standards.md`

## 現状の準拠状況

verify はほぼ準拠済み: McpServer + registerTool + zod、annotations、stdout-guard、
`assertReadablePdf`（絶対パス + サイズ上限）、Biome 2.5.4 固定、logger Pattern C。

## 残タスク（優先度順）

1. **エラー応答の語彙を reader 形式へ寄せる（低優先・機能追加のついでで可）**
   現在の `PdfVerifyError` は `code` + `suggestion`。family 標準（規約 §2.3）は
   `code` / `retryable` / `hint` / `next_actions`。内部クラスは維持してよく、
   **MCP 応答の整形層**（`handleStructuredError`）だけ揃えれば足りる。
   編成 Skill（pdf-trust / pdf-publish）が verify のエラーで分岐するため、
   `VERAPDF_NOT_AVAILABLE`（→ native へフォールバックした事実）等の明示が特に有用。

2. **PDF/UA 構造モデルの共有検討（pdf-engine-core の種）**
   `pdfua-validator.ts`（判定側）と writer の `struct-tree.ts` / `struct-append.ts`（生成側）は
   同じ ISO 14289 構造モデル（構造タグ語彙・RoleMap・ParentTree の不変条件）を別実装している。
   今すぐの統合は不要。**Tier C / pdf-fusion で pdf-engine-core を切り出す際の第一候補**として、
   規則 ID・clause 定義・構造要素型を共有可能な形（純粋型 + 定数）に保つことを意識する。

3. **G-1（名称衝突）の決着は別件のまま**
   specs/01 の主題「AI 抽出結果照合」は本リポジトリのスコープ外。役割分担提案どおり
   別パッケージ（`pdf-extract-verify-mcp`）推奨で、本リポジトリに混ぜない。

## 判定の決定論化（[Issue #4](https://github.com/shuji-bonji/pdf-verify-mcp/issues/4)・2026-07-17 追記）

Issue #4 の指摘: verify の返すファクトは決定論的だが、それを 4 値判定
（trust_and_use / reject 等）に統合するのが LLM（trust skill）である限り、
エッジケースの解釈ブレ・本文内容への過剰適合・モデル更新によるドリフトを排除できない。
提案されている解法は「**ジャッジはコード、ナラティブは LLM**」のハイブリッド。

family での実装候補（優先度順の私案）:

1. **verify に決定論的な判定ツールを追加**（例: `evaluate_policy`）—
   verify_signatures / verify_integrity / validate_conformance の結果 + プロファイル
   （trust skill の references をルール JSON 化したもの）を入力に、4 値判定と
   発火したルール ID を返す。LLM は判定に触れず、解説と推奨アクションの文章化に専念する。
   「判定を返すのは verify」という境界ルールとも整合する
2. 暫定（Skill 内ガードレール）: trust skill の判定表に「LLM が上書きしてはならない
   絶対規則」を明記する（例: `verdict: invalid` → 無条件 reject。本文内容を判定材料に
   しない）。コード化までのつなぎ
3. **pdf-publish 側は既にこの原則に準拠**していることを維持する — 合否 = veraPDF の
   compliant（決定論）であり、LLM の裁量は「ゲート水準の提案」と「修正手段の選択」に
   限定されている。学習データのラベルが決定論的であることは北極星の要件でもある

## 出力パイプライン（pdf-publish Skill）での役割

`specs/07-pdf-publish-skill.md` にて、verify は**品質ゲート（Phase 3）**を担う。
新規実装は不要だが、次の契約を安定に保つこと:

- `validate_conformance` の verdict 形式（`compliant: true / false / null` の 3 値と
  engine の明示）は publish の判定表（07 §4）が直接依存する。**破壊的変更は publish と同時改訂**
- `compliant: null`（native・検査範囲内違反なし）は「必要条件のみ」であることを
  応答内で今後も明示し続ける（writer 側が受け入れ基準の但し書きとして参照している）
- writer の出力を native 規則の実測ベンチに使う運用（CLAUDE.md §3）は継続してよいが、
  **writer のバージョンを記録**すること（現記述は v0.4.0 の実測。writer は v0.6.0 に進んでいる）
