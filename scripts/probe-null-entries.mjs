#!/usr/bin/env node
/**
 * 「値が null の辞書エントリ」が検体にどれだけ在るかを数える。
 *
 * ISO 32000-2 §7.3.7:
 *   "A dictionary entry whose value is null shall be treated the same as if
 *    the entry does not exist."
 *
 * `@normativepdf/recover` の `has()` は `dict.entries.has(key)` を見ており、
 * この条文を当てていない（`get()` は `dictGet` 経由で当てている）。
 * verify の validator は `has(descriptor, 'FontFile')` のように
 * **「宣言されているか」を訊く**ために使っているので、値が null のとき
 * 条文に反して true を返す = 埋め込まれていないものを埋め込み済みと答える。
 *
 * 直す前に、その軸が検体集合に在るかを測る。無いなら A/B は 0 件になり、
 * それは「変わらなかった」ではなく「その形が集合に無い」である。
 *
 * 使い方: node scripts/probe-null-entries.mjs [--offset N] [--limit N]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateObjects, openDocument } from '@normativepdf/recover';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SETS = [
  join(ROOT, '.golden/specimens'),
  join(ROOT, 'tests/fixtures/generated'),
  resolve(ROOT, '../../lib/normativepdf/corpus/veraPDF-corpus'),
  resolve(ROOT, '../../lib/normativepdf/corpus/pdf20examples'),
  resolve(ROOT, '../../lib/normativepdf/corpus/_wout'),
];

/** verify の validator が has() で訊いている鍵。ここに null が入ると答えが反転する */
const ASKED = new Set([
  'FontFile', 'FontFile2', 'FontFile3', 'ID', 'EmbeddedFiles', 'XFA', 'AA',
  'ByteRange', 'Contents', 'VRI', 'Filter',
]);

function listPdfs(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const argv = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i === -1 ? dflt : Number(argv[i + 1]);
};
const offset = num('--offset', 0);
const limit = num('--limit', Infinity);

const files = SETS.filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })
  .flatMap(listPdfs);
const picked = files.slice(offset, offset + limit);

let opened = 0;
let failed = 0;
let withNull = 0;
let incomplete = 0;
const keyCount = new Map();
const askedHits = [];

for (const f of picked) {
  let doc;
  try {
    ({ doc } = await openDocument(new Uint8Array(readFileSync(f))));
    opened++;
  } catch {
    failed++;
    continue;
  }
  let hit = false;
  let walkFailed = false;
  /**
   * 🔴 直接値の辞書は入れ子の中にも居る。**上から降りる。**
   * 最初に書いたときは間接オブジェクトの最上位しか見ておらず、しかも
   * `dict.entries`（Map そのもの）を `dict.entries.entries` と書いていたので
   * 毎回 throw して catch に落ち、**全検体で 0 件と報告していた**。
   * 数えていないことを 0 件と報告する計器は、無いより悪い。
   */
  const walk = (value, depth) => {
    if (depth > 24 || value === null || value === undefined) return;
    if (value.kind === 'dict') {
      for (const [k, val] of value.entries) {
        if (val?.kind === 'null') {
          hit = true;
          keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
          if (ASKED.has(k)) askedHits.push(`${f.replace(ROOT, '.')} /${k}`);
        }
        walk(val, depth + 1);
      }
      return;
    }
    if (value.kind === 'array') {
      for (const item of value.items) walk(item, depth + 1);
      return;
    }
    if (value.kind === 'stream') walk(value.dict, depth + 1);
  };
  try {
    const { objects } = await enumerateObjects(doc);
    for (const entry of objects) walk(entry.object, 0);
  } catch {
    // 数え上げの途中で落ちたら、その検体はここまで。**黙らない**
    walkFailed = true;
    incomplete++;
  }
  if (hit) withNull++;
  void walkFailed;
}

console.log(`検体 ${picked.length}（offset ${offset}）/ 開けた ${opened} / 開けない ${failed} / 🔴 数え上げが途中で落ちた ${incomplete}`);
console.log(`値が null のエントリを持つ検体: ${withNull}`);
const top = [...keyCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log(`鍵の内訳（上位 ${top.length}）:`);
for (const [k, n] of top) console.log(`  /${k.padEnd(24)} ${n}${ASKED.has(k) ? '  🔴 has() で訊いている鍵' : ''}`);
console.log(`\n🔴 has() で訊いている鍵に null が入っている箇所: ${askedHits.length}`);
for (const h of askedHits.slice(0, 20)) console.log(`  ${h}`);
