# pdf-verify-mcp 残タスクリスト

| 項目 | 内容 |
| --- | --- |
| 作成日 | 2026-07-25 |
| 最終更新 | 2026-07-25（**v0.8.0 = V-F3（#9）+ instructions**。V-F1 / V-D1 / V-F2 は未着手） |
| 現状 | **v0.8.0**（2026-07-25・リリース待ち）= V-F3（#9）で PAdES を観測として明示（`normativeBasis: 'T3'`）＋ **`instructions` 導入**。v0.7.1 = V-A1 / V-A2 の advisory 穴を封鎖（**verdict 不変**）。6 ツール（`verify_signatures` / `verify_integrity` / `detect_pades_level` / `identify_conformance` / `validate_conformance` / `evaluate_policy`）。veraPDF 委譲 + native サブセット（PDF/A 15 規則 / PDF/UA 12 規則）のハイブリッド |
| 基準 | `docs/PROJECT_PLAN.md`（v0.1 時点の計画。**現状と乖離あり**）／ `docs/family-standards-alignment.md`（family 共通規約への整合）／ `docs/FINDINGS-2026-07-20.md`（④ 実連携で発見した穴 2 件・解決済み）／ PDFfamily `specs/01-pdf-verify-mcp.md` |

## 番号規約

本リポジトリのタスク番号は 3 系統に分ける。**分類の基準は「ツールの出力が変わるか」**。

| 接頭 | 意味 | 判定 | 出所 |
| --- | --- | --- | --- |
| **V-A\*** | **Audit** — 実連携や監査で見つかった「穴」（既存挙動の不備） | 出力が変わる（穴を塞ぐ） | `docs/FINDINGS-*.md` に観測・原因・提案を書き、ここに 1 行で索引する |
| **V-F\*** | **Feature** — 機能追加・対応範囲の拡張・**出力文言の変更** | **出力が変わる** | 本ファイルに直接起票、または GitHub Issue を索引 |
| **V-D\*** | **Docs** — リポジトリ内文書のみ | **出力は不変** | 本ファイルに直接起票 |

> **GitHub の `documentation` ラベルとは基準が違う。** 出力文言を変えるものは（ドキュメント作業に見えても）**V-F** に入れる。
> 例: Issue #9（PAdES に T3 を明示）はラベルは `documentation` だが、`detect_pades_level` の**出力**が変わるので **V-F3**。

> writer 側の `docs/TASKS.md` §D（family 連携）の **M-\* 番号と対応**させる。
> 例: **V-F1 ⇄ writer M-9**（同じ作業を、依頼側 = writer と実装側 = verify の両方から見た起票）。

## GitHub Issue 索引

**本ファイルは正典ではなく作業一覧。Issue 本文は複製しない**（二重管理を避ける）。
family 側のギャップ台帳は **`Document-Note/mcps/PDFfamily/specs/12-use-cases.md §5`**（Issue リンク付き・そちらが正典）。

| Issue | 件名（要約・実タイトルは Issue 参照） | ラベル | 本ファイル | family ギャップ | UC |
| --- | --- | --- | --- | --- | --- |
| [#8](https://github.com/shuji-bonji/pdf-verify-mcp/issues/8) | `verify_integrity` にリビジョン間のオブジェクト単位差分を追加 | `enhancement` | **V-F2** | G-B | UC-10 |
| [#9](https://github.com/shuji-bonji/pdf-verify-mcp/issues/9) | PAdES 判定結果に「規範根拠なし（T3・推定）」を明示 | `documentation` | **V-F3** | G-C | UC-1 |
| [#4](https://github.com/shuji-bonji/pdf-verify-mcp/issues/4) | 判定の決定論化 | — | `docs/family-standards-alignment.md` §判定の決定論化 | — | — |
| [#1](https://github.com/shuji-bonji/pdf-verify-mcp/issues/1) | プロジェクト計画 | — | `docs/PROJECT_PLAN.md` | — | — |

**V-F1 は Issue 未起票**（2026-07-25 に本ファイルで起票）。writer B-20 の前提なので、着手時に Issue を立てるかは実装者の判断。

## 出力表示規則 — 規範の 3 層（T1 / T2 / T3）

> **正典は `specs/09-family-scope.md §2`（3 層モデル）。本節はそれを verify の出力にどう落とすかの規則。**
> **V-F1（PDF/A-4 = T2）と V-F3（PAdES = T3）は、実装が別々でもこの型に従う。**
> 揃えないと同じ `validate_conformance` / `detect_pades_level` の出力で層の示し方が不統一になる。

| 層 | 対象 | **言ってよいこと** | **言ってはいけないこと** |
| --- | --- | --- | --- |
| **T1** | ISO 32000-1/-2、ISO 14289-1/-2、ISO/TS 32001〜32005、WTPDF、Tagged PDF BPG、PDF Declarations、AN001〜003 | **条文を引用して断定できる** | — |
| **T2** | **PDF/A（ISO 19005-1〜4）** | 「**veraPDF はこう判定した**」 | 「**ISO 19005 準拠**」 |
| **T3** | **ETSI EN 319 142（PAdES B-B/B-T/B-LT/B-LTA）**、その他コーパス外 | 「**構造がこれに一致する**」= 観測（下記の決着を参照） | 「**PAdES B-LT に適合**」= 適合判定 |

### 実装の型

- **層は文章に埋め込まず、機械可読なフィールドで返す**（Skill が分岐に使えるように）。
  例: violation / level ごとに `normativeBasis: "T1" | "T2" | "T3"` を持たせる。文言はそこから生成する。
  - 既存フィールドとの衝突なし（`ConformanceViolation` は `ruleId` / `clause` / `description` / `detail` / `severity?`）。camelCase も規約どおり
  - **`clause` との軸の違いを定義に明記する**: `clause`（例 `'ISO 19005-1, 6.1.3'`）は「**どの規範か**」、
    `normativeBasis` は「**その規範を条文で引けるか**」。両者は独立
  - ✅ `detect_pades_level` 側は **v0.8.0 で `PadesLevelReport.normativeBasis` を新規追加**（型名は `PadesReport` ではない）
- **T1 は昇格ルートを使う**（`specs/09 §2`「T2 → T1 の昇格ルート」）。
  veraPDF の指摘が ISO 32000-1 を参照している場合、**是正指示だけは T1 に降ろせる**。
  原文（`09 §2`）: 「違反の**是正指示**はこの経路で条文まで降ろせます。違反の**成立根拠**（19005 側の条文）は T2 のままです」。
  **違反の成立根拠は T2、是正指示は T1** という非対称を出力で区別する。
  - 09 の実例はフォント未埋め込み（`ISO 19005-2 6.2.11.4.1-1` → `pdf17 §9.9`）
  - **B-8 の `/ID` 欠落（`6.1.3-1`）→ ISO 32000-1 §14.4 も同じ経路だが、射程に注意**:
    §14.4 は `ID` を「**optional but should be used**」とするので、**T1 で示せるのは「値の作り方」（2 要素のバイト列・permanent + changing）まで**。
    「存在しなければならない」という**義務は PDF/A 側（T2）にしかない**。ここを混ぜると T2 の義務を T1 の断定に見せてしまう
- **native 判定と veraPDF 判定を混ぜない**。
  ⚠️ **現状 `engine: 'auto'` で veraPDF 不在にフォールバックした事実は `notes` にしか出ない**
  （実在するエラーコードは `VERAPDF_NOT_FOUND` のみで、`engine: 'verapdf'` を**明示指定した場合だけ** throw される。
  `conformance-validation.ts:107-112`）。
  §C-1 が提案している **`VERAPDF_NOT_AVAILABLE` は未実装**。導入すれば編成 Skill が分岐できる
- **T2/T3 は「検証していない」と「違反がない」を区別する**。
  `specs/09 §2`: 「検索がヒットしないことは『要件が存在しない』証拠ではなく『答えられない』を意味する」

### ✅ 決着 — T3 は「観測」を許し「適合判定」を禁じる（2026-07-25）

`specs/09 §2` は当初 T3 を「**保留。判定を出さない**」と定義していたが、`detect_pades_level` は
現に B-B / B-T / B-LT / B-LTA を返していた。**境目を引き直して決着した**（09 §2 に
「T3 における観測と判定の分界」を追記）:

| | 例 | 出してよいか |
|---|---|---|
| **観測** | 「RFC 3161 タイムスタンプがあり、DSS が署名者証明書を覆っている」 | ✅ ファイルを読めば分かる事実 |
| **観測からの推定** | 「構造は B-LT に**一致する**」 | ✅ 規範根拠なしと明示する限り |
| **適合判定** | 「PAdES B-LT **に適合している**」 | ❌ ETSI 原文を照合していない |

**境目は「ファイルに何があるか」（観測可能）と「それが規格を満たすか」（規範が必要）。**
`pdf-reader-mcp` が自身について立てているのと同じ分界であり、**`detect_pades_level` は
`detect` であって `validate_*` ではない**という命名も既にそれを含んでいた。

> **T2 との違い**: T2（PDF/A）には veraPDF という第三者判定器があるので「**veraPDF はこう判定した**」と
> 判定主体を名指しできる。T3 には判定器が無く、判定しているのは family 自身の構造検査である。
> だから T3 は「誰が判定したか」ではなく「**これは観測であって判定ではない**」と述べる。

## B. Feature（V-F\*）

- [ ] **V-F1. `validate_conformance` に PDF/A-4 flavour を追加**（2026-07-25 起票）
      **writer 側の依頼番号は M-9。writer B-20（PDF/A-4 正規化）の前提タスク。**
      ロードマップ: `Document-Note/mcps/PDFfamily/specs/16-pdfa4-roadmap.md` 第一段階 §1。

  **✅ 一次情報（2026-07-25 実測）**: `validate_conformance(flavour: "pdfa-4")` → **`INVALID_FLAVOUR`**。
  **family の窓口が閉じている**ため、writer B-20 の `write → validate → 直す` ループが**そもそも回らない**。

  > **⚠️ 二次情報（未実測・要検証）**
  > 内容: veraPDF は **1.20** で PDF/A-4（core / Level F / Level E）を実装し、flavour コードは
  > **`4` / `4e` / `4f`**。**PDF/A-4 は conformance レベルを持たず `4b` は存在しない**（`4e` = Engineering / `4f` = file attachments）。
  > 情報源: veraPDF 公式ドキュメント・リリースノート（`docs.verapdf.org/cli/validation/`・`verapdf.org/news/`）
  > 信頼度: 高（一次配布元）だが **ホスト実機では未確認**。ISO 19005-4 はコーパス外（**T2**）なので条文でも裏を取れない。
  > **着手時に `verapdf --version` と `--flavour` の受理値を実測して、この節を一次情報に書き換えること。**

  **着手条件**: ホストの `verapdf --version` ≧ **1.20**（上記の閾値は二次情報。**実測で確定させる**）。
  更新する場合は **UC-2（PDF/UA-1 = 106/106）と UC-4（PDF/A-3b = 143/146）の回帰確認込み**で行う。
  実務上のリスクは低い（閾値が誤っていても `INVALID_FLAVOUR` 相当で即座に判明する）が、
  **「まず veraPDF を更新する」という手順の前提が崩れる**ため印を付けている。

  ### 要改修 3 箇所

  | # | 箇所 | 現状 | 変更 |
  | --- | --- | --- | --- |
  | 1 | `src/services/pdfa-validator.ts:370` `resolveFlavour()` | `/^pdfa-([123])([abu])?$/i` | part 4 を許可。**4 は `a`/`b`/`u` を取らず `e`/`f` を取る** |
  | 2 | `src/services/conformance-validation.ts:66` `veraFlavourId()` | `` `${flavour.part}${(flavour.conformance ?? 'B').toLowerCase()}` `` | part 4 は `4` / `4e` / `4f` を返す（**`4b` を作らない**） |
  | 3 | `src/services/pdfa-validator.ts:213` native version 上限 | `ctx.flavour.part === 1 ? 1.4 : 1.7` | part 4 は **2.0** を許可 |

  ### 付随（片方だけ直すと description と実挙動がずれる）

  - **`PdfaFlavour` の型設計を先に決める**（`src/services/pdfa-validator.ts:19-24`）。
    現在 `/** 1 | 2 | 3 */ part` と `/** 'A' | 'B' | 'U' | null */ conformance`。
    **-4 のサブレベル（`e`/`f`）を `conformance` に相乗りさせるか別フィールドにするか**で
    `flavourLabel()`（`conformance-validation.ts:61`）の出力にも波及する
  - **flavour 例の更新は 2 箇所**: `src/tools/validate-conformance.ts:22`（Zod `.describe()`）と
    `:60`（tool description 本文）
  - **native PDF/A 15 規則（`PDFA_NATIVE_RULE_COUNT`）のうち -4 で要件が変わるものを洗う**。
    確実に変わるのは **`pdf-version`（2.0 許可）** と **`no-transparency`（-4 は透明性を許可）**。
    `no-embedded-files` は -4f の扱いに直結。`file-id` は -4 では PDF 2.0 側の義務としても必須
  - **`notes` に「-4 の native 判定はオラクルに劣後する参考値」と明示する**。
    ISO 19005-4 はコーパス外（**T2**）なので条文で裏を取れない ⇒ 断定してはいけない。
    **文言は §出力表示規則の型に従う**（`normativeBasis: "T2"` / 「veraPDF はこう判定した」まで。
    「ISO 19005-4 準拠」とは言わない）。**V-F3 とセットで設計する**

  ### テスト方針

  **veraPDF との一致で担保する。** native 単独の緑は空振りしうる
  （フィクスチャ不在 + `if` ガードで High 3 件が生き延びた前例がある）。
  **M-1（PDF/UA flavour 追加・v0.6.0）の教訓を適用**: native の指摘が veraPDF の指摘と矛盾しないことを
  実検体で確認し、native では届かない項目も洗い出して記録する。

- [ ] **V-F2. `verify_integrity` にリビジョン間のオブジェクト単位差分を追加**
      → **[Issue #8](https://github.com/shuji-bonji/pdf-verify-mcp/issues/8)（正典・本文は複製しない）**。
      family ギャップ **G-B**（`specs/12 §5`）・**UC-10** の前提。
      **V-A1（v0.7.1）の粗い前身を精緻化するもの** = 「署名後に N バイト足された」を
      「どのオブジェクトが変わったか」に上げる。**verdict は動かさない**（増分更新は PDF で合法）。
      復号済み文書に対して動く必要がある（**`src/services/decrypt-document.ts`** の後段。
      同ディレクトリの `decryptor.ts` とは別物なので注意）。
      **G-A（reader [#20](https://github.com/shuji-bonji/pdf-reader-mcp/issues/20)）と対で、両方揃って UC-10 が完遂する**
- [x] **V-F3. PAdES 判定結果に「規範根拠なし（T3・観測）」を明示**（**v0.8.0**・2026-07-25）
      → **[Issue #9](https://github.com/shuji-bonji/pdf-verify-mcp/issues/9)（正典）**。
      family ギャップ **G-C**・**UC-1** のレポート品質。ラベルは `documentation` だが
      **`detect_pades_level` / `evaluate_policy` の出力が変わるので V-F 扱い**（§番号規約）。
      **実装**: `PadesLevelReport.normativeBasis: 'T3'`（`types.ts`）を追加し `evaluate_policy` の
      `facts.padesLevels` にも伝播。notes を「**The structure matches PAdES X … not a conformance
      verdict**」に（旧 `Detected level: X` は断定形だった）。markdown は**注記を level より前に**置く
      （後に置くと数字を読んだ後に読まれる）。既存 advisory は呼び出し側が文言照合しているので
      needle を保ったまま「構造からの推定であって ETSI 条文由来ではない」を追記。
      **`instructions` も同版で導入**（T1/T2/T3 の射程 + 「反証しかできない」+ trust/revocation の限界）。
      **T3 の定義は §A の決着どおり**（観測は出す・適合判定は出さない）

## C. family 共通規約への整合

詳細は **`docs/family-standards-alignment.md` §残タスク**（優先度順・そちらを正典とする）。索引のみ:

1. エラー応答の語彙を reader 形式へ寄せる（`code` / `retryable` / `hint` / `next_actions`）— 低優先・機能追加のついでで可。
   編成 Skill が分岐するため `VERAPDF_NOT_AVAILABLE`（native フォールバックした事実）の明示が特に有用
2. PDF/UA 構造モデルの共有検討（`pdfua-validator.ts` ⇄ writer の `struct-tree.ts`）— pdf-engine-core の第一候補。今すぐの統合は不要
3. G-1（名称衝突）の決着は別件のまま — `pdf-extract-verify-mcp` 推奨で本リポジトリに混ぜない
   （**= `mcps/pdf-family-role-architecture.md:72` の M-5「抽出結果照合は別パッケージへ分離推奨」と同じ話**。
   family 横断で追跡できるよう **G-1 / M-5** の併記で覚えておく）

## D. Docs（V-D\*）— ツール出力は不変

- [ ] **V-D1. `docs/PROJECT_PLAN.md` を現状に追随させる**（2026-07-25 起票・低優先）
      §7 マイルストーンは **v0.1 MVP 時点の gantt** のままで、v0.3 に「PDF/A・PDF/UA 準拠検証（範囲再検討）」が
      未着手として残っている。**実際は v0.3.0 で veraPDF 委譲（PDF/A）が入り、v0.6.0 で PDF/UA と
      `--flavour ua1`/`ua2` 委譲まで広がって、現在 v0.7.1**（CHANGELOG `[0.3.0]` / `[0.6.0]`）。
      §2 スコープ表の「v0.1 は XMP 宣言の**識別**のみ」も現状と合わない。
      **V-F1 で PDF/A-4 まで広がるので、その際に併せて改訂するのが自然**
      （Issue [#1](https://github.com/shuji-bonji/pdf-verify-mcp/issues/1) が出所なので、改訂したら同 Issue にも反映する）

## 関連

- `Document-Note/mcps/PDFfamily/specs/15-kickoff-b8-pdfa.md`（writer B-8 = PDF/A-3b。Step 0 決着の実測値）
- `Document-Note/mcps/PDFfamily/specs/16-pdfa4-roadmap.md`（**PDF/A-4 の 2 段階ロードマップ。V-F1 の出所**）
- `Document-Note/mcps/PDFfamily/specs/01-pdf-verify-mcp.md`（上位仕様）
- `pdf-writer-mcp/docs/TASKS.md` §D（M-1 = PDF/UA flavour 追加の先例 / **M-9 = V-F1 の依頼側**）
