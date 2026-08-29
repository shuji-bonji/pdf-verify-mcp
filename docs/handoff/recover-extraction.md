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

---

## 7. 実施結果（2026-08-29）

済んだのは §4 の 1〜4。**5（publish）は残っている。**

| 面 | 結果 |
|---|---|
| A/B | `.golden/after-0.21.1.json` ↔ `.golden/after-recover.json` で **差 0 件**（2,950 検体 × 7 ツール = 20,650 呼び出し） |
| 空振りの対 | `golden.mjs t3` が **14 件とも差を報告** |
| 分布 | `probe-scope.mjs` は `chainStop` 5 値・`reconstructed` 7 件・`sections` の 0 が 7 件 —— §3 のとおり |
| テスト | verify 191 件・recover 9 件が緑 |

コミット: recover `ba8cddf`（`lib/recover`）・verify `722fe67`。**どちらも未 push。**

### §2 の 3 つをどう解いたか

- `logger` → `options.onDebug?: DebugSink`。既定はどこにも出さない。
  verify は 5 か所（`plaintext-copy` / `pdf-parser` ×2 / `clause-validation` /
  `revision-diff`）で `onDebug: logger.debug` を渡し、`DEBUG` を立てたときの
  stderr 出力を移送前と同じに保つ
- `XrefKind` / `ReadingScope` → recover の `src/types.ts` で定義。
  verify は `export type { ReadingScope, XrefKind } from '@normativepdf/recover'`

### §4-2 の「テストはそのまま移せる」は違った

`tests/unit/document-scope.test.ts` の 15 件のうち、`openDocument` だけに掛かるのは
最初の describe の **5 件**。残り 10 件は verify の formatter / error-handler /
pdf-parser / 各 validator を測っている。**5 件だけ recover へ写し、verify 側は
15 件のまま残した**（あちらは境界の統合検査になる）。
recover には `onDebug` の検査 4 件を新設した（呼ばれる / 空振りの対 /
渡さなくても同じ scope / **stdout に 1 バイトも書かない**）。

### 🔴 publish の順序（測って分かった制約）

**`@normativepdf/recover` が npm に出るまで、verify の `package-lock.json` は
更新できない。** `npm install --package-lock-only` も `npm ci` も、registry に
無いパッケージを解けない。いまの verify は:

- `package.json` の `dependencies` に `"@normativepdf/recover": "0.1.0"` がある
- `package-lock.json` は**まだ 0.21.1 のまま**・版も 0.21.1 のまま
- CHANGELOG は `[Unreleased]` に書いてある（publish.yml が `[Unreleased]` の
  空を見るので、tag の前に `## [0.22.0]` へ移す）

この状態で verify に tag を打つと CI の `npm ci` が落ちる。順序は:

```
1. lib/recover を GitHub に置く   ✅ 済み = https://github.com/shuji-bonji/recover
2. 🔴 0.1.0 だけ手元から publish する（Trusted Publisher は使えない・下記）
     npm publish --access public --provenance=false
3. npmjs.com のパッケージ設定 → Trusted Publisher に
     リポジトリ shuji-bonji/recover ・ workflow publish.yml を登録
4. verify で npm install → package-lock.json を commit
5. CHANGELOG の [Unreleased] を [0.22.0] に移す → 版を 0.22.0 に上げる
6. push --follow-tags（🔴 忘れると 0.20.0 と同じ欠番になる）
```

### 🔴 なぜ 0.1.0 だけ手元から出すのか

**Trusted Publisher の設定画面はパッケージのページの中にあり、registry に
まだ無いパッケージには設定できない。** 卵が先か鶏が先かで、npm はまだ
解いていない（[npm/cli#8544](https://github.com/npm/cli/issues/8544) は
2026-08-29 時点で open。PyPI は「存在しないパッケージへの事前登録」で
解いていると同 issue が書いている）。

実測（2026-08-29）: `https://registry.npmjs.org/@normativepdf%2frecover` は
`{"error":"Not found"}`。

`publishConfig.provenance: true` を宣言してあるので、CI の外で `npm publish`
すると provenance を作れずに落ちる。初回だけ `--provenance=false` を付ける。
**0.1.0 には provenance が付かない。0.1.1 以降は workflow が付ける。**
`normativepdf` 本体も scoped パッケージも、この org では初めてになる ——
scope `@normativepdf` への publish 権限が npm 側にあることを 2 で同時に確かめる。

### 手元の配線（publish 前に A/B を採るために作ったもの）

`node_modules/@normativepdf/recover/` に `npm pack` の中身を展開してある
（マウント側・コンテナ側とも）。lock は触っていない。
**2 の `npm install` でこれは正規のものに置き換わる。**

### そのほか

- `scripts/golden.mjs` の `depVersions()` は固定リストだったので
  `@normativepdf/recover` を足した。足さないとヘッダに版が出ず、
  上がっても計器がその日から何も言わない
- 落とした 3 ファイルと古い `dist/services/{cos,xref-walk,document}.*` は
  `pdf-agent-stack/_to_delete/` へ `mv` してある（device_bash は `rm` を通さない）
