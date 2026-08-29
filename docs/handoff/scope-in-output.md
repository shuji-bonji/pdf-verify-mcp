# 0.20.0 の計画 —— 判定の射程を出力に載せる

> 前提: `docs/handoff/pdflib-removal.md`（B2）。0.19.0 公開済み。
> 基準は `.golden/base-0.19.0.json`（2,947 検体 × 7 ツール = 20,629 呼び出し）。

## 1. 決めること

`DocumentScope`（`src/services/document.ts`）は、**その文書をどう読んだか**を 12 項目で
申告する。いまは内部にしか出ていない。`ParsedPdf.scope` のコメントにこう書いてある。

> 出力に載せるかは道具ごとに決める。

これを決める。載せる方向で、**載せる前に直すもの**と**測っておくもの**を先に並べる。

理由は 1 つ。`reconstructed: true` の文書は、**相互参照表が verify の推測**である。
ファイルが持っている表ではない。実測で 2,946 件のうち 6 件がこれに当たる。
この 6 件と、ファイルの表で読めた 2,940 件を、いまの出力は見分けられない。
監査の読み手にとって、これは伏せてよい事実ではない。

## 2. 実測 —— 出力の互換性

### 2.1 このサーバの出力には schema が無い

- `src` 全体で `outputSchema` と `structuredContent` は **0 件**
- 7 ツールが返すのは `content: [{ type: 'text', text }]` の 1 ブロックだけ。
  `response_format` が `json` なら `JSON.stringify(report, null, 2)`、
  `markdown` なら整形した文
- 0.18.0 で入力に入れた `.strict()`（宣言していない鍵を拒む）に相当するものは
  **出力側に存在しない**。鍵が増えてもプロトコル層は何も言わない
- `src/index.ts` は何も export しない（`check:public-types` が見る `dist/index.d.ts` は
  数行）。**`ParsedPdf` も `DocumentScope` も公開型ではない** → 型の互換性の話にならない

### 2.2 壊れうるのは 3 つだけ

| 呼び出し側 | 起きること |
|---|---|
| JSON を鍵の名前で取る | 何も起きない |
| JSON の完全一致スナップショット | 差分が出る（1 度だけ更新が要る） |
| zod `.strict()` 等で parse | 通らなくなる |
| markdown を人・LLM が読む | 何も起きない |
| markdown を節の並び・行番号で取る | ずれる |

### 2.3 前例（L1 の実測）

`validate_clauses` に `observation` を足したときの A/B。

| | |
|---|---|
| 検体 | 2,947 |
| うち「前の版に無かった鍵が増えただけ」（バケツ J） | **2,904** |
| 判定が動いたもの | **0** |

**鍵を 1 つ増やす変更は、差分としてはほぼ全件に出る。** 7 ツールに載せれば同じことが
7 倍の規模で起きる（差分約 20,000 件・判定 0 件）。

## 3. 実測 —— `scope` の 11 項目は実際どれだけ動くか

`scripts/probe-scope.mjs` を書いて、同じ 2,947 検体に `openDocument` を直接当てた
（1.9 秒）。開けたのは 2,946 件、例外 1 件。

| 項目 | 分布 |
|---|---|
| `recovered` | false 2,928 / **true 18** |
| `refusal != null` | false 2,927 / **true 19** |
| `chainStop.kind` | complete 2,938 / **unreadable 7** / **prev-zero 1** / cyclic **0** / malformed **0** |
| `newestSectionUnreadable` | false 2,937 / **true 9** |
| `continuedPastStop` | false 2,945 / **true 1** |
| `filledFromScan > 0` | false 2,944 / **true 2** |
| `reconstructed` | false 2,940 / **true 6** |
| `encrypted` | false 2,934 / **true 12** |
| `authenticated` | true 2,944 / **false 2** |
| `sections` | **0 が 2,931** / 1 が 14 / 4 以上が 1 |
| `objects` | 全件で非 0 |

### 3.1 🔴 `sections` は健全な文書で常に 0 —— 意味が経路依存

3 つの文書で中身を並べた。

```
健全       {"recovered":false,"chainStop":{"kind":"complete"},"sections":0,"objects":7,...}
recovered  {"recovered":true,"chainStop":{"kind":"complete"},"sections":1,"objects":7,
            "refusal":"cross-reference section shall begin with the keyword xref (§7.5.4)..."}
prev-zero  {"recovered":true,"chainStop":{"kind":"prev-zero"},"sections":8,"objects":152,
            "continuedPastStop":true,"filledFromScan":24}
```

**健全な文書の `sections: 0` は「相互参照節が 0 個」ではない。**
ライブラリがそのまま読んだ経路では節を数えていない、というだけである。
このまま出すと、読み手は「節が 0」と読む。

これは `observation` を足したときに直したのと**同じ間違い**を `scope` 自身が持っている
という話である —— 観測していないことと、観測して 0 だったことが同じ顔をしている。
載せる前に直す（数えるか、経路を分けて `null` にするか）。

### 3.2 この集合が踏んでいない値

- `chainStop.kind` の **`cyclic` と `malformed` は 0 件**
- `continuedPastStop` / `filledFromScan > 0` はそれぞれ **1 件・2 件**（どちらも同じ 1 検体）
- `authenticated: false` は **2 件**

つまり **回復方針が当たる経路はほとんど踏まれていない。** このまま載せると、
「載せた項目がどう動くか」を一度も見ずに公開することになる。

## 4. 実測 —— 0.19.0 が見えるようにした別の不整合（エラーコード）

`.golden/base-0.19.0.json` の `isError` は **26 件・20 ファイル**。
**26 件すべて、メッセージが条文を名指ししている。** ところが:

| `code` | 件数 | ツール |
|---|---|---|
| `INTERNAL_ERROR` | 20 | `validate_clauses` |
| `PARSE_FAILED` | 6 | 他の 6 ツール（同じ 1 ファイル） |

```json
{"error":true,"code":"INTERNAL_ERROR",
 "message":"cross-reference section shall begin with the keyword xref (§7.5.4) or be a cross-reference stream object (§7.5.8.1) (at byte 0)"}
```

**「この文書は §7.5.4 に反する」を `INTERNAL_ERROR` で返している。**
これは文書についての所見であって、サーバの故障ではない。原因は
`handleStructuredError` が `PdfVerifyError` 以外を全部 `INTERNAL_ERROR` に落とすところ。
normativepdf が投げる条文エラーは `PdfVerifyError` ではない。

困るのは受け側である。pdf-trust の Trust Report には
「未実施項目（ツール未接続・取得失敗）」という枠がある。`INTERNAL_ERROR` はそこに落ちる。
すると **「§7.5.4 に反している」という所見が「調べられませんでした」として報告される。**
下手な文書ほど無罪になる。

0.19.0 が作った問題ではない。0.18.0 までは pdf-lib がこれらを読んでしまっていたので、
そもそも `isError` にならなかった。**撤去が見えるようにした。**

## 5. 弊害（載せる側）

| # | 弊害 | 対処 |
|---|---|---|
| 1 | A/B の差が約 20,000 件出る（判定は 0 件） | バケツ J で分離できる。`scope` 追加だけの commit にして、直後に基準を採り直す |
| 2 | 出力が 11 項目 × 7 ツール分ふくらむ。markdown も 1 節増える | 判定の**前**に置く。`observation` と同じ扱い |
| 3 | 🔴 `refusal` は条文の英文がそのまま入る。内部の申告用に書いた文字列で、外に出す文面として設計していない | 文面を契約にするか、`refusal` は載せずに `chainStop` と `recovered` だけにする |
| 4 | 🔴 `encryptDict` は normativepdf の COS 辞書。`JSON.stringify` すると内部表現が出る | 載せない。必要なら `/V` `/R` `/Filter` の値だけ取り出す |
| 5 | 🔴 `sections` の意味が経路依存（§3.1） | 載せる前に直す |
| 6 | 🔴 踏んでいない値がある（§3.2） | 検体を先に足す |

## 6. 段取り

```mermaid
flowchart TD
    S0["S0 検体を足す<br/>cyclic / malformed / reconstructed"] --> S1
    S1["S1 sections の意味を直す<br/>経路に依らない定義にする"] --> S2
    S2["S2 scope を出力に載せる<br/>7 ツール・判定の前"] --> S3
    S3["S3 基準を採り直す<br/>base-0.20.0.json"] --> S4
    S4["S4 エラーコードを直す<br/>条文の所見を INTERNAL_ERROR にしない"]
```

### S0 検体を足す（出力は動かさない）

`scripts/golden-specimens.mjs` に 3 つ足す。

- `chainStop.kind = 'cyclic'` —— `/Prev` が自分か祖先を指す
- `chainStop.kind = 'malformed'` —— `/Prev` が整数でない
- `reconstructed = true` を**意図して**作った検体（いまの 6 件は veraPDF の fail 検体で、
  こちらが狙って作ったものではない）

足したら `take` して、`probe-scope.mjs` の分布に 5 値すべてが出ることを確かめる。
**この段階では出力は 1 バイトも動かない** —— A/B の差は検体が増えた分だけ。

### S1 `sections` を直す（出力は動かさない・内部のみ）

ライブラリがそのまま読んだ経路でも節を数える。数えられないなら `null` にして
「この経路では数えていない」を型で表す。`0` は使わない。
テストは `sections` が経路によらず同じ意味を持つことを固定する。

### S2 `scope` を出力に載せる

- 載せる項目: `recovered` / `chainStop` / `newestSectionUnreadable` / `sections` /
  `continuedPastStop` / `filledFromScan` / `reconstructed` / `objects` /
  `encrypted` / `authenticated`（10 項目）
- 載せない: `encryptDict`（COS 辞書）。`refusal` は §5-3 の決着しだい
- 置き場所: 各ツールの報告の**先頭**。markdown は
  `Scope of this reading` を判定より前（`validate_clauses` と同じ形）
- 文言: 「判定ではなく、判定の射程」と本文に書く

### S3 基準を採り直す

```
node scripts/golden.mjs take .golden/base-0.20.0.json --label 0.20.0
node scripts/golden.mjs diff .golden/base-0.19.0.json .golden/base-0.20.0.json
node scripts/golden.mjs t3   .golden/base-0.20.0.json
```

差はすべてバケツ J であること、判定が動いた件数が 0 であることを確かめる。
0 件を主張する側には必ず t3 を対にする。

### S4 エラーコードを直す（§4）

条文を名指しする失敗に、故障と区別できるコードを与える。
`INTERNAL_ERROR` は本当に内部で落ちたときだけに戻す。
7 ツールで同じコードを使う（いまは `validate_clauses` だけ違う）。

🔴 これは pdf-trust の Trust Report の書き方に届く。`skill/pdf-trust-skill` の
「未実施項目（ツール未接続・取得失敗）」の枠に、**条文違反は入らない**と書き足すこと。
エラー契約の統一（4 サーバを揃える）は別 Issue のままでよい —— ここで直すのは
「所見を故障と呼ばない」の 1 点だけ。

## 7. 受入

| 面 | 何を見るか |
|---|---|
| 1 項目が動く | `probe-scope.mjs` の分布に `chainStop` の 5 値すべてが出る。`sections` が健全な文書で 0 にならない |
| 2 出力の A/B | `base-0.19.0` → `base-0.20.0` の差が**全部バケツ J**。判定が動いた件数 0。空振り検査の対は t3 の 14 件 |
| 3 受け側 | `reconstructed: true` の検体で、報告を読んだだけで「相互参照表は verify が組み直した」と分かる。`INTERNAL_ERROR` が条文違反に付かない |

## 8. 版と順序

- **0.20.0**（minor）。既存の鍵の意味も名前も変えず、鍵を足す = `feat`。
  S4 のコード変更は、いまの値が誤りなので同じ版に入れてよい
- 他リポジトリの追随（Skill の推奨版・plugin・pipeline）は **0.20.0 の後**。
  S4 が pdf-trust の書き方に届くので、まとめて 1 度で当てる
- `agent/pdf-agent-pipeline` の SDK v2 移行は独立（0.18.0 由来の宿題）

## 9. 0.19.0 の時点で他リポジトリに要る修正（実測）

| 対象 | 判定 |
|---|---|
| `site/` | **不要**。リファレンスは 0.19.0 で再生成済み（`observation` が入っている）・origin と同期 |
| Skill 3 本 / plugin | **必須の修正は無い**。`validate_clauses` を呼ぶ Skill は **0 本**（grep 0 件）なので `observation` は届かない。推奨版の表記（`v0.17.0+`）は嘘になっていない |
| `agent/pdf-agent-pipeline` | 0.19.0 由来ではない。SDK v1 クライアントのままという 0.18.0 の宿題 |
| **verify 自身** | 🔴 §4 のエラーコード。0.19.0 が見えるようにした |
