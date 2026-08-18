# pdf-verify-mcp 残タスクリスト

| 項目 | 内容 |
| --- | --- |
| 作成日 | 2026-07-25 |
| 最終更新 | 2026-08-04（**v0.14.0 = V-P2**（DocMDP の違反判定が P=1 しか見ていなかった欠陥の是正。`changeClass` + 3 値の `violationAssessment`）。**ホストの test / check → publish 待ち**。V-D1 は未着手） |
| 現状 | **v0.14.0**（2026-08-04・**publish 待ち**）= **V-P2 = DocMDP の違反判定が P=1 しか見ていなかった欠陥の是正**（ISO 32000-2 Table 257 に沿って P ごとに判定。オブジェクト差分に **`changeClass`** を足し、**`violationAssessment` は 3 値**（`permitted` / `violated` / **`indeterminate` = pass ではない**）。`evaluate_policy` に **`POL-REVIEW-DOCMDP-INDETERMINATE`**）。**fail open だったものを塞いだ**。**出所は C-3b の署名検体**（P=1/2/3 × 同じ注釈の追加）。テスト 128 件・検体 12 点で実測。**v0.13.0**（2026-07-29・**公開済み**。境界遵守 eval の **E-6b が 3/3 PASS** = 「未実施を報告が持ち帰るか」の初の実測）= **V-A3 = `PDF_VERIFY_VERAPDF` が実行可能かを検査せず採用していた欠陥の是正**（不正な env は PATH の別バイナリで代替せず、`auto` は native + **未実施の明示**、`verapdf` 指定は **`VERAPDF_NOT_AVAILABLE`**）＋ レポートに **`authoritativeValidation`**（`performed` / `reason` / `detail`。markdown では規則数より上に出す）＋ `evaluate_policy` の advisory（**verdict 不変**）。**出所は family の境界遵守 eval の E-6**。**v0.12.0**（2026-07-28・**公開済み・npx 検証 PASS**）= **`validate_clauses` が第 3 ドメイン「注釈」（CT-ANNOT-1〜15・ISO 32000-2 §12.5）を持つ**（`@shuji-bonji/pdf-constraints` の pin を **0.1.0 → 0.3.0**）＋ **failure の Context 行**（制約が持つ文脈をレポートまで運ぶ。CT-ANNOT-9 = QuadPoints の反時計回りは業界がほぼ一様に逸脱しているため、文脈なしでは欠陥として誤読される）。**ドメイン一覧はパッケージから読むので `domains` と description は自動追随**。**手順の順序**（constraints → verify の 2 リリース）は実行済み。**v0.11.0**（2026-07-27・公開済み）= **V-F1（M-9）= `validate_conformance` に PDF/A-4（`pdfa-4` / `pdfa-4e` / `pdfa-4f`）**。実 veraPDF 1.30.0 で 109 規則を回すことを実測（`pdfa-4b` は拒否）。**v0.10.0**（2026-07-27・**公開済み**）= **V-F2（#8）= `verify_integrity` にリビジョン間オブジェクト単位差分**（`revisions` / `objectChangesAfterLastSignature`。**verdict 不変**。ローカル MCP で実検体試用 PASS）。v0.9.0（2026-07-26）= **V-P1 修正**（/Contents の padding 除去が DER 末尾の 0x00 を削り、約 1/256 の署名を「解析不能」と誤報告していた。DER ヘッダの長さで切り出すよう是正・600 検体中 4 件が該当し全て通過）+ **`validate_clauses` 追加**（ISO 32000 本体条文 = T1。判定は `@shuji-bonji/pdf-constraints@0.1.0` に委譲・exact pin・レポートに版を明記）。**7 ツール**。v0.8.0（2026-07-25）= V-F3（#9）で PAdES を観測として明示（`normativeBasis: 'T3'`）＋ **`instructions` 導入**。v0.7.1 = V-A1 / V-A2 の advisory 穴を封鎖（**verdict 不変**）。ツールは `verify_signatures` / `verify_integrity` / `detect_pades_level` / `identify_conformance` / `validate_conformance` / `validate_clauses` / `evaluate_policy`。veraPDF 委譲 + native サブセット（PDF/A 15 規則 / PDF/UA 12 規則）のハイブリッド |
| 基準 | `docs/PROJECT_PLAN.md`（v0.1 時点の計画。**現状と乖離あり**）／ `docs/family-standards-alignment.md`（family 共通規約への整合）／ `docs/FINDINGS-2026-07-20.md`（④ 実連携で発見した穴 2 件・解決済み）／ PDFfamily `specs/01-pdf-verify-mcp.md` |

## 番号規約

本リポジトリのタスク番号は 3 系統に分ける。**分類の基準は「ツールの出力が変わるか」**。

| 接頭 | 意味 | 判定 | 出所 |
| --- | --- | --- | --- |
| **V-A\*** | **Audit** — 実連携や監査で見つかった「穴」（既存挙動の不備） | 出力が変わる（穴を塞ぐ） | `docs/FINDINGS-*.md` に観測・原因・提案を書き、ここに 1 行で索引する |
| **V-P\*** | **Wrong answer** — **答えそのものが誤っていた**もの（穴ではなく誤答） | **出力が変わる（正しくなる）** | 本ファイルに直接起票。**再現手順と実測を必ず残す** |
| **V-F\*** | **Feature** — 機能追加・対応範囲の拡張・**出力文言の変更** | **出力が変わる** | 本ファイルに直接起票、または GitHub Issue を索引 |
| **V-D\*** | **Docs** — リポジトリ内文書のみ | **出力は不変** | 本ファイルに直接起票 |

> **V-A と V-P の境目**: V-A は「**見ていなかった**」（測れない・報告しない）、
> V-P は「**見て、違うことを言った**」。後者の方が危険で、**利用者は誤りに気づけない** ——
> だから V-P は再現手順と実測を必須にする。
> V-P1（0.9.0・`/Contents` の padding 除去が DER を削り署名を「解析不能」と誤報告）と
> V-P2（0.14.0・DocMDP の違反を見逃す）はどちらもこの型で、
> **2 件とも「大量に測ったら食い違った」から見つかっている**（600 検体 / P=1,2,3 の対）。

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
  ✅ **v0.13.0（V-A3）で解決**: フォールバックした事実は `authoritativeValidation`
  （`performed` / `reason` / `detail`）として**機械可読**に返り、markdown では規則数より上に出る。
  `reason` は `not_installed` / `configured_path_unusable` / `native_engine_requested` の 3 値で、
  編成 Skill はこれで分岐できる。`engine: 'verapdf'` 明示時のエラーは
  **`VERAPDF_NOT_AVAILABLE`**（設定が不正）と `VERAPDF_NOT_FOUND`（どこにも無い）に分かれた
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

## A. Audit（V-A\*）

- [x] **V-P2. DocMDP の違反判定が P=1 しか見ていなかった**（2026-08-04 起票・**v0.14.0** で是正）
      **出所は C-3b の署名検体**（`Document-Note/mcps/PDFfamily/specs/25` §4.1.1）。
      P=1 / P=2 / P=3 で証明し、**同じ注釈を同じように増分追加した検体**を並べたところ、
      **P=2 だけが予測と食い違った**。実装は 1 行で説明がついた:

      ```ts
      violatedByLaterChanges: permission === 1 && laterChanges && !laterChangesAppearLtvOnly
      ```

      **`permission === 1` で始まるので、P=2 と P=3 は何を足されても違反にならない。**
      ISO 32000-2 **Table 257** は P=2 について「filling in forms, instantiating page templates,
      and signing」だけを許し、**それ以外は "shall invalidate the signature"** と書いている
      （注釈の作成が許されるのは P=3 から）。

      🔴 **`evaluate_policy` まで伝播していた。** `POL-REVIEW-DOCMDP-VIOLATION` はこのフィールドを
      発火条件にしているので、**条文違反の変更が入った文書が `human_review_required` に上がらず**
      `use_with_caution` で返っていた —— **見逃す方向（fail open）**である。

      **是正の要点は 4 つ**:
      1. **変えたのは閾値ではなく問い** —— 「バイトが増えたか」ではなく「**どんな種類の変更か**」。
         材料は v0.10.0 のオブジェクト差分がすでに持っていた
      2. `RevisionObjectChange.changeClass` を新設（機械可読）。**規則が読むのは `role`（散文）ではない** ——
         文言を良くしただけで規則が壊れるのを避ける
      3. **`violationAssessment` は 3 値**。`indeterminate` は **pass ではない**
         （`validate_clauses` の `needs_external_fact` と同じ規律）。
         `violatedByLaterChanges`（boolean）は互換で残すが **`indeterminate` を `false` に潰す**
      4. `POL-REVIEW-DOCMDP-INDETERMINATE` を新設 —— 判定不能でも人手確認に上げる。
         **読めない文書を数件レビューする方が、安い誤り**である

      **付随的な変更は違反に数えない。** `/Annots` が増えたページ・カタログ・`/Info`・XMP は
      `housekeeping`。実測で**正当な P=3 の注釈追加でもこの 4 つが必ず動く**ので、
      数えると全証明書文書が違反になる。

      ⚠️ **裸のストリーム（`/Type` 無し）は `content` ではなく判定不能**にした。
      同じバイトがフォームの外観ストリーム（P=2 で許される）にもページ内容（どの P でも不可）にも
      なりうる —— `content` と読めば**示されていない違反**を報告し、`housekeeping` と読めば**本物を通す**。

      **教訓**: eval の 43 ケースは **P=1 の検体しか持っていない**ので、26 回の通しで
      1 度も踏まれていなかった（[[green-tests-can-be-vacuous]]）。
      **予測を書いてから測ったから見つかった** —— 測ってから予測を合わせていたら、
      `false` が正解として検体に記録され、学習データが「P=2 は違反でない」を教えていた。

- [x] **V-A3. `PDF_VERIFY_VERAPDF` が無検査で採用されていた**（2026-07-29 起票・**v0.13.0** で是正）
      **出所は family の境界遵守 eval**（`Document-Note/mcps/PDFfamily/evals/boundary`）。
      E-6（veraPDF を切ったとき「未実施」と報告するか）が 4 回まわして一度も採点できず、
      README は原因を「env が MCP サーバの子プロセスに届かない」と記録していた。**実際は verify 側**で、
      `findVeraPdf()` が env のパスだけ `access(X_OK)` を掛けずに採用していた（well-known パスは掛けている）。
      結果、実在しないパスが「見つかった」として通り、`execFile` の中で ENOENT になって
      **`veraPDF execution failed: spawn … ENOENT` というレポート無しのエラー**になっていた。
      観測できるはずのフォールバックがそもそも存在しなかったので、E-6 は永久に判定不能だった。

      **是正の要点は 3 つ**:
      1. env のパスも実行可能性を検査する
      2. **不正な env で PATH の別バイナリに落ちない** — 誰も選んでいない検証器の判定は、判定が無いより悪い
      3. `engine: "auto"` は native に落ちて**未実施を明示**し、`engine: "verapdf"` は
         **`VERAPDF_NOT_AVAILABLE`** で失敗する（`VERAPDF_NOT_FOUND` は「どこにも入っていない」のまま）

      **`authoritativeValidation`**（`performed` / `reason` / `detail`）をレポートに追加し、
      markdown では**規則数より上**に出す。`evaluate_policy` にも advisory として運ぶ（**verdict 不変**）。
      C-1（エラー語彙の family 標準化）が名指ししていた `VERAPDF_NOT_AVAILABLE` の初出でもある。

      **公開後の実測（2026-07-29）**: eval の **E-6b が 3/3 PASS**。報告は
      `authoritativeValidation.performed = false` を引用し、「disprove はできるが
      certification にはならない」と自分で書き分けた。**この eval で最初の「未実施検出」の実測**。
      E-6（env で切る側）は、エージェントがシェルの veraPDF に回り込むため依然測れていない
      （eval 側で Bash を禁止 = cases v6）。**verify 側の作業ではない。**

      **教訓**: eval が 4 回「測れなかった」と言い続けたのは正しかった。
      偽の数字を出さなかったので、原因を実装まで追える状態が保たれていた
      （[[green-tests-can-be-vacuous]] の裏返し = **判定不能を用意しておくことの利得**）。

## B. Feature（V-F\*）

- [ ] **V-F5. `verify_integrity` の説明が「歩き切れなかったチェーン」を `revisions: null` の場合しか書いていない**（2026-08-13 起票・**0.15.2 予定**）

  **着手用の引き継ぎ: [`handoff/0.15.2-V-F5.md`](handoff/0.15.2-V-F5.md)**（別セッションが 1 枚読めば始められる形）

  現在の説明はこの 1 行だけ。

  > `revisions: null` means the cross-reference chain could not be walked — "not determined", NOT "nothing changed".

  **`revisions` が非 null でも、リストが完全とは限らない。** チェーンが途中で切れた場合
  （`truncated`）と、最新セクションが読めず古い入口から入った場合（`newestSectionUnreadable`）は、
  リストは返るが**そのファイルの全リビジョンではない**。両方とも `notes` には出るが、
  ツール説明が `null` の場合しか警告していないため「リストがあるなら全件」と読める。

  **0.15.0 でこれが実害になった。** 同版で `/Prev 0` を追えないリンクとして正しく報告する
  ようになった結果、**打ち切りが立つ検体が増えた**（それ以前は黙って「完全なチェーン」に
  化けていた）。信号を直したのに説明を直していないのは片手落ち。

  0.15.0 のタグ直前に発見。説明文の変更はツール出力が変わる（V-F）ので、公開直前の駆け込みを
  避けて次版に回した。**0.15.2 の内容はこれ 1 件**。
  （当初は 0.15.1 の予定。0.15.1 には veraPDF の版の記録が入ったので 1 件動かした）

  - [ ] `src/tools/verify-integrity.ts` の Limits に 1 行追加
  - [ ] `pdf-trust` skill 側の対応（`legal.md` / `contract.md` の「全履歴」の扱い）は
        skill 0.5.1 で先に入れている。説明と skill の言い回しを揃える

- [x] **V-F1. `validate_conformance` に PDF/A-4 flavour を追加**（2026-07-25 起票・**v0.11.0**・2026-07-27）
      **writer 側の依頼番号は M-9。writer B-20（PDF/A-4 正規化）の前提タスク。**
      ロードマップ: `Document-Note/mcps/PDFfamily/specs/16-pdfa4-roadmap.md` 第一段階 §1。

  **✅ 一次情報（2026-07-25 実測）**: `validate_conformance(flavour: "pdfa-4")` → **`INVALID_FLAVOUR`**。
  **family の窓口が閉じている**ため、writer B-20 の `write → validate → 直す` ループが**そもそも回らない**。

  ### 実装（2026-07-27・**v0.11.0**）

  > **当初 v0.10.0 に同乗させるつもりだったが、0.10.0 は既に npm に公開済みだった**
  > （公開版の `gitHead` は V-F2 のコミット = M-9 の 1 つ前）。公開済みの版に後から
  > 中身を足すことはできないので **0.11.0 として切り出した**。CHANGELOG も分けてある。

  **決定①: `e` / `f` は `conformance` に相乗りさせる。** 別フィールドにしない。
  理由は「同じ 1 スロットだから」— `pdfaid:conformance` も veraPDF の profile id（`2b` / `4e`）も、
  レベルと variant を同じ位置に置く。フィールドを分けると 2 つを同期させる責務が生まれるだけで、
  `flavourLabel()` は `PDF/A-4` / `PDF/A-4e` / `PDF/A-4f` を無改修で出す。
  **代わりに part ごとの語彙を関数 1 つに閉じる**（`allowedConformance(part)`）。

  | # | 箇所 | 変更後 |
  | --- | --- | --- |
  | 1 | `resolveFlavour()` | `/^pdfa-([1234])([abuef])?$/i` + part ごとの語彙検査。**`pdfa-4b` / `pdfa-2e` は `null`（= `INVALID_FLAVOUR`）** |
  | 2 | `veraFlavourId()` | part 4 は `4` / `4e` / `4f`。**`?? 'B'` の既定は part 1-3 のみに適用**（`4b` を作らない） |
  | 3 | `pdf-version` 規則 | part 4 は範囲ではなく **`=== 2.0`**（PDF/A-4 は ISO 32000-2 基盤なので「上限」ではない） |
  | 4 | `output-intent` 規則 | **`appliesToParts: [1,2,3]`**。-4 で必須かは条文が引けない（T2）⇒ **推測で fail を作らずオラクルに委ねる** |
  | 5 | `extractPdfaId()` | `[ABUEFabuef]` を受理しつつ **part 4 = E/F・part 1-3 = A/B/U 以外は落とす**（part 2 + `F` のような宣言を veraPDF に渡さない） |
  | 6 | `notes`（part 4 のとき） | 「native 規則は ISO 19005-1/-2 由来で **-4 で検証していない**。veraPDF に劣後する参考値」 |

  **`no-transparency` / `no-embedded-files` は変更不要だった**（起票時の見込みと違う）。
  どちらも `appliesToParts: [1]` で -4 に届いていないため、-4 が透明性・添付を許すことは
  現状の規則と矛盾しない。**「-4 で緩む」規則を緩める必要は無く、緩めるべきは -4 に効いていた
  `output-intent` の方だった**。

  **`pdfaid:rev` の検査は入れていない。** -4 が `rev` を要求するという情報は二次情報のみで、
  条文が引けない状態で native 規則にすると**誤 fail を製造する**。→ 下記「T2 残件」に送る。

  ### 受け入れ実測（2026-07-27 ホスト・dist 直叩き）

  `npm test` **113 passed / 13 files**、`npm run check` 緑（`check:fix` で test の整形 1 件）。
  実 veraPDF を通した結果（検体 = `tests/fixtures/generated/pdfa-declared.pdf`）:

  | flavour | engine | label | 結果 | 最初の違反 |
  | --- | --- | --- | --- | --- |
  | `pdfa-4` | verapdf | PDF/A-4 | 102/**109** | `ISO 19005-4:2020 6.1.3-1` |
  | `pdfa-4e` | verapdf | PDF/A-4e | 102/**109** | `ISO 19005-4:2020 6.1.2-1` |
  | `pdfa-4f` | verapdf | PDF/A-4f | 101/**109** | `ISO 19005-4:2020 6.7.3-2` |
  | `pdfa-4b` | — | — | **`INVALID_FLAVOUR`**（拒否） | — |

  **窓口が開いたことの証拠は規則 ID の側にある** — `ISO 19005-4:2020` が返ってきている以上、
  veraPDF は確かに -4 の profile を回している（-3b は `ISO 19005-3:2012`）。
  **規則数は -4 = 109、-3b = 146**。-4f だけ 1 件多く落ちる（`6.7.3-2`）＝ 3 profile は別物として動いている。
  `compliant=false` は検体（PDF/A-2 用のフィクスチャ）の性質であって -4 対応の失敗ではない。

  **回帰**: UC-2 = `pdfua-1` で **106/106 COMPLIANT を維持**。

  > **⚠️ UC-4 は本当の意味では測れていない。** 上記で `pdfa-3b` に使ったのは `pdfnative-audit/out4/`
  > の検体（145/146）で、**B-8 の受け入れ値 146/146 を出した writer `ensure_pdfa` の出力ではない**
  > （後者はサンドボックス上に残っていない）。今回言えるのは「**3b profile が従来どおり 146 規則で起動した**」
  > までで、146/146 の再現ではない。**parts 1-3 の経路はコード上 1 行も変わっていない**
  > （`resolveFlavour` の語彙検査・`veraFlavourId` の既定・`pdf-version` の分岐・`output-intent` の
  > `appliesToParts: [1,2,3]` は、いずれも part 4 以外では従前と同一の枝を通る）が、
  > **B-20 着手時に `ensure_pdfa` 出力で 146/146 を取り直すこと**。

  ### T2 残件（第二段階 = ISO 19005-4 購入後に条文で当てる）

  | # | 項目 | 現状の扱い | 条文で確かめること |
  | --- | --- | --- | --- |
  | T2-1 | OutputIntent の必須性 | -4 では native 規則を**適用しない** | -4 が無条件に要求するのか、色空間の使用が条件なのか |
  | T2-2 | `pdfaid:rev` | **検査しない** | -4 の識別に `rev`（発行年）が必須か。必須なら native 規則を追加する |
  | T2-3 | `e` / `f` の分岐条件 | 文字列として受けるだけ | -4e / -4f を名乗れる条件（3D・添付の種別） |
  | T2-4 | PDF 版数 | `=== 2.0` と断定 | -4 が 2.0 のみか、以降の 2.x を許すか |
  | T2-5 | native 15 規則の残り | -1/-2 由来のまま -4 に適用 | -4 で消えた/変わった要件が無いか（LZW・暗号化・アクション） |

  **✅ 一次情報（2026-07-27 ホスト実測・`verapdf --version` / `verapdf -l`）**

  ```
  veraPDF 1.30.0   Built: Wed Jun 03 13:47:00 JST 2026
    ... 3u - PDF/A-3u / 4 - PDF/A-4 / 4f - PDF/A-4f / 4e - PDF/A-4e / ua1 / ua2 / wt1r / wt1a
  ```

  **着手条件（≧ 1.20）は既に満たしていた** — veraPDF の更新は不要で、UC-2 / UC-4 の回帰も
  「更新に伴う回帰」としては発生しない（**flavour 追加そのものの回帰確認は別途必要**）。
  `4` / `4e` / `4f` の 3 profile が実在し、**`4b` は一覧に無い**ことも実機で確認済み
  （起票時の二次情報 = veraPDF ドキュメントは正しかった。ISO 19005-4 が **T2** であることは変わらない —
  実測できたのは「veraPDF に profile がある」ことだけで、条文の内容ではない）。

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

- [x] **V-F2. `verify_integrity` にリビジョン間のオブジェクト単位差分を追加**（**v0.10.0**・2026-07-27）

  **実装**: `src/services/revision-diff.ts`（新規・pdf-lib 非依存）。生バイトで xref チェーンを歩く
  （`startxref` → `/Prev`、classic table / xref stream / hybrid-reference の 3 形式 + PNG predictor 解除）。
  `IntegrityReport` に `revisions` と `objectChangesAfterLastSignature` を追加。
  型は**そのリビジョンの生バイトから**読む（pdf-lib は最終形しか見えない＋暗号化 PDF でも
  辞書キーと名前は非暗号 = ISO 32000-1 §7.6.2）。ObjStm 内のオブジェクトは `inObjectStream: true` で型なし。

  **verdict は不変**。`policy-engine.ts` が読むフィールドは変えていない（`evaluate_policy` の facts も未変更）。

  **素朴に作ると嘘をつく 3 点**（実測で発見。対処済み）:

  | # | 罠 | 実測 | 対処 |
  | --- | --- | --- | --- |
  | 1 | **線形化（Annex F）は 1 セーブで xref が 2 つ** | reader の `linearized.pdf` が 2 リビジョン・10 件の幻の追加 | 新しい方のオフセットが**古い方より小さい**ことで検出し 1 リビジョンに併合。実測で 1 リビジョンに是正 |
  | 2 | **フルセーブは全オブジェクト書き換え** | `pdfreference1.7old.pdf` で **224,065 件** | 一覧を上限 200 に。`changeCount` に真値・**bookkeeping から先に落とす**。型読み取り自体も候補集合に限定（全件 peek で 45 秒超のタイムアウトを実測） |
  | 3 | **歩けない ≠ 変更なし** | `startxref 0` を書く既存フィクスチャ `appended.pdf` | チェーン不可時は空配列でなく **`null`**。最後の `startxref` が壊れている場合は古い入口から入り、**「末尾は表現されていない」と明示** |

  **実測**: 手元の 128 PDF（ISO 仕様書・生成フィクスチャ・暗号化・線形化）で **error 0 / null 1**（意図的に壊した `corrupted.pdf` のみ）。
  `pdfnative-audit/out4/signed-then-annotated.pdf`（実検体）で **署名リビジョン（Sig / Widget / AcroForm）と
  その後の注釈追記（Highlight + 参照するページ）を分離**できることを確認 = UC-10 の問いそのもの。

  **実機試用で 1 件是正（2026-07-27）**: ISO 32000-2 本体（3 リビジョン・変更 1014 + 2010 件）で
  **JSON 応答が 25,000 字上限を超えて構造の途中で切れた**。上限を 200 → **25 件/リビジョン**に下げ、
  切るときの順位を **①型が読めたもの → ②ObjStm 内（番号しか分からない） → ③bookkeeping** の 3 段にした
  （元は bookkeeping かどうかの 2 段で、番号だけの ObjStm エントリが枠を食い潰していた）。
  再実測: 128 検体で最大 11 KB。**上限は「切ったこと」を `changesTruncated` と `changeCount` で必ず言う**ので
  黙って落とすことにはならない。

  **残**: reader [#20](https://github.com/shuji-bonji/pdf-reader-mcp/issues/20) と揃って UC-10 完遂。
  リリース後は npx 公開版で検証（[[verify-published-package-by-npx]]）。

  <details><summary>起票時の記述</summary>
      → **[Issue #8](https://github.com/shuji-bonji/pdf-verify-mcp/issues/8)（正典・本文は複製しない）**。
      family ギャップ **G-B**（`specs/12 §5`）・**UC-10** の前提。
      **V-A1（v0.7.1）の粗い前身を精緻化するもの** = 「署名後に N バイト足された」を
      「どのオブジェクトが変わったか」に上げる。**verdict は動かさない**（増分更新は PDF で合法）。
      復号済み文書に対して動く必要がある（**`src/services/decrypt-document.ts`** の後段。
      同ディレクトリの `decryptor.ts` とは別物なので注意）。
      **G-A（reader [#20](https://github.com/shuji-bonji/pdf-reader-mcp/issues/20)）と対で、両方揃って UC-10 が完遂する**
  </details>
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
