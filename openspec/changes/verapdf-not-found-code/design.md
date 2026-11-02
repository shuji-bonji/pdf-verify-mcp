# Design

## 「どこにも無い」を作る方法

veraPDF の探し方は `src/services/verapdf.ts` の `lookUpVeraPdf` にあり、次の順で探します。

1. 環境変数 `PDF_VERIFY_VERAPDF`（設定されていれば、ここで決まる。012）
2. PATH（`which verapdf`）
3. 決まった場所（`WELL_KNOWN_PATHS`: `/opt/homebrew/bin/verapdf`・`/usr/local/bin/verapdf`・`/usr/bin/verapdf`）

テストで「どこにも無い」を作るには、3 段とも外す必要があります。

| 段 | 外し方 |
| --- | --- |
| 1 | テストの中で `PDF_VERIFY_VERAPDF` を消し、終わったら戻す（既存のテストと同じ） |
| 2 | テストの中で `PATH` を空のフォルダーだけにし、終わったら戻す。`which` 自体が見つからなくなり、`execFile` の失敗は catch されて 3 段目に進む |
| 3 | **今は外せない。** Homebrew で veraPDF を入れた Mac では `/opt/homebrew/bin/verapdf` が見つかる。これが、既存のテストが先頭で `return` していた理由 |

## 差し替えの入口

3 段目の候補を、テストから差し替えられるようにします。

```ts
let wellKnownPaths: readonly string[] = WELL_KNOWN_PATHS;

/** テストだけが使う。決まった場所の候補を差し替える。null で既定に戻す。 */
export function setWellKnownPathsForTesting(paths: readonly string[] | null): void {
  wellKnownPaths = paths ?? WELL_KNOWN_PATHS;
  resetVeraPdfCache();
}
```

- `src/index.ts` からは公開しない（パッケージの公開の型は `npm run check:public-types` が見ている 2 件のまま）。
- 既定の候補と探す順序は変えない。利用者から見える振る舞いは変わらない。
- 環境変数で候補を差し替える案は採らない。テストのためだけに、利用者が触れる設定を増やすことになるため。

## ライブラリの制約と仕様の制約

- 仕様の制約: なし。どちらの `code` も PDF/A・PDF/UA の規格ではなく、このサーバーのエラーの約束。
- 実装の制約: Node の `execFile` は、実行ファイルを `PATH` から探す。`PATH` を空のフォルダーにすると `which` を起動できず、2 段目は例外になる（今の実装は catch して 3 段目へ進む）。

## veraPDF のある環境と無い環境

| 環境 | 変更前 | 変更後 |
| --- | --- | --- |
| veraPDF が無い（CI） | `VERAPDF_NOT_FOUND` のテストは走るが、文言だけを見る | 3 段とも外したうえで `code` を見る |
| veraPDF がある（手元の Mac） | テストは先頭で `return` し、何も確かめない | 同じテストが走り、同じ答えになる |
