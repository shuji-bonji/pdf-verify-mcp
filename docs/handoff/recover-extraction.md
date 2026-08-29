# `@normativepdf/recover` の切り出し — 着手前の 1 枚

> 決裁は [ADR-0010](../../../../lib/normativepdf/docs/adr/0010-recover-package.md)（2026-08-29・shuji）。
> npm 名は 2026-08-29 時点で**空き**（org `normativepdf` は確保済み・scoped は 0 件）。
> **この作業は reader の pdf-lib 撤去より先**（reader は最初からこのパッケージの上で書く）。

## 1. 何を出すか

verify の `src/services/` から 3 ファイル、**1,189 行**。

| ファイル | 行 | 中身 |
|---|---:|---|
| `cos.ts` | 230 | COS の読み口（`asDict` / `asRef` / `tryResolve` / `enumerateObjects` / `decodedBytes` …）。**判定は書かない** |
| `xref-walk.ts` | 476 | `walkXrefChain` / `reconstructXref` と回復方針 3 段。`findOrigin` / `LATIN1` / `readToken` などのバイト操作も |
| `document.ts` | 483 | `openDocument` / `DocumentScope` / `toReadingScope` |

verify 側で **14 ファイル**がこの 3 つを import している。

## 2. 解くもの 3 つ（これだけ）

| いま | どうするか |
|---|---|
| `import { logger } from '../utils/logger.js'`（36 行・`DEBUG` のとき stderr へ出すだけ） | パッケージ側では落とすか、`options.onDebug?: (context, message) => void` にする。**stdout には絶対に書かない**（MCP の stdio を壊す） |
| `import type { XrefKind } from '../types.js'`（`'table' \| 'stream' \| 'hybrid'` の 1 行） | パッケージ側で定義して export。verify は再 export で受ける |
| `import type { ReadingScope } from '../types.js'` | **一緒に移す**（`DocumentScope` と対で意味を持つ） |

依存は `normativepdf` **1 つだけ**になる。ほかに何も要らない。

## 3. 受入 = A/B の差 0 件

**同じコードの置き場所が変わるだけなので、差が出たら移し方を間違えている。**

```
node scripts/golden.mjs take .golden/after-recover.json --label after-recover
node scripts/golden.mjs diff .golden/after-0.21.1.json .golden/after-recover.json
   → 差 0 件 であること
node scripts/golden.mjs t3 .golden/after-recover.json
   → 14 件とも差を報告（0 件が空振りでないことの対）
```

基準は `.golden/after-0.21.1.json`（2,950 検体 × 7 ツール = 20,650 呼び出し）。
`scripts/probe-scope.mjs` の分布も同じであること（`chainStop` 5 値・
`reconstructed` 7 件・`sections` の 0 が 7 件）。

## 4. 段取り

1. `lib/recover/` に新リポジトリを作る（ADR-0009 §2 と同じ置き方。
   コーパス基盤は持たない）。`package.json` は `@normativepdf/recover`・
   `dependencies: { normativepdf: "0.9.0" }`・`engines.node >= 20`
2. 3 ファイルを移し、§2 の 3 つを解く。テストは verify の
   `tests/unit/document-scope.test.ts`（15 件）と
   `scripts/lib/xref-specimen-builder.mjs` がそのまま移せる
3. verify で `dependencies` に足し、14 ファイルの import 元を替え、
   `src/services/{cos,xref-walk,document}.ts` を落とす
4. **A/B を採る（§3）**
5. verify 0.22.0 として出す。CHANGELOG には「出力も判定も変わっていない・
   実行時依存が 1 つ増えた」と書く

## 5. そのあと

- **reader の pdf-lib 撤去**（`mcp/pdf-reader-mcp/docs/handoff/pdflib-removal.md`）を
  最初からこのパッケージの上で書く
- `@shuji-bonji/pdf-constraints` で 3 つ（依存を足す / `src/check.ts` 53 行目の
  `parsePdf` を `openDocument` に / `src/facts/cos.ts` 141 行の削除）を行い、
  **いま検査していない 20 件の行方を実測する**（ADR-0010 の受入 3）

## 6. 環境（そのまま効く）

- **push は device_bash からできない**（SSH 鍵が無い）。commit + tag までがこちらの仕事
- **マウント上で `npm install` を打たない**（ホストの darwin バイナリが linux のものに置き換わる）
- ビルドとテストは**コンテナへ往復する**: マウントで tar → `device_stage_files` →
  `/tmp/vm` で `npm ci` → `tsc` / `biome` / `vitest` / `npm run build` → tar →
  `SendUserFile` → `device_commit_files` → **`cat` で 1 ファイルずつ上書き**
  （tar の展開は unlink が要るので通らない）。**dist も戻す** —— 計器は dist を読む
- `.golden/` は gitignore・**消さない**
- publish は **tag `v*` の push で発火**。🔴 `--follow-tags` を忘れると版が欠番になる
  （verify 0.20.0 で実際に起きた）
