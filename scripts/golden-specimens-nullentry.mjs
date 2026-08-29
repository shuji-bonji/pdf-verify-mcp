#!/usr/bin/env node
/**
 * 「値が `null` の辞書エントリ」の検体 2 件を作り、`manifest.json` に足す。
 *
 * **なぜ要るか**: この軸を持つ検体はコーパスに **2 件しかない** ——
 * veraPDF の `6-2-10-4-1-t01-{pass,fail}-a.pdf` が `/FontFile3 null` を持つだけで、
 * どちらも「在るべき鍵」の向きである。**「在ってはならない鍵」の向き
 * （`/AA null` など）を踏む検体は 1 件も無い。**
 *
 * 🔴 この数は一度間違えた。`scripts/probe-null-entries.mjs` の初版が
 * `dict.entries.entries`（Map そのものを再度 `.entries`）と書いていて毎回 throw し、
 * catch に落ちて**全検体を「0 件」と報告していた**。数えていないことを 0 件と
 * 報告する計器は、無いより悪い。いまは落ちた件数を出す。
 *
 * 2 件は**同じ組み立てで値だけが違う**（`scripts/lib/null-entry-specimen-builder.mjs`）:
 *
 *   null-valued-entry.pdf  `/FontFile2 null` と `/AA null`
 *   valued-entry.pdf       `/FontFile2 7 0 R` と `/AA << >>`   ← 空振り検査の対
 *
 * 0.1.1 で 2 件の答えが**逆になる**ことを実測してある:
 *
 *   recover 0.1.0   どちらも fonts-embedded=pass / no-aa-catalog=FAIL（2 件を区別できない）
 *   recover 0.1.1   null 側は fonts-embedded=FAIL / no-aa-catalog=pass
 *                   値あり側は fonts-embedded=pass / no-aa-catalog=FAIL
 *
 * 🔴 `golden-specimens.mjs` は走らせないこと —— あれは 21 検体を作り直す。
 * ここは **足すだけ**で、既存の検体には触らない。
 *
 * 使い方: node scripts/golden-specimens-nullentry.mjs [--force]
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { specimens } from './lib/null-entry-specimen-builder.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, '.golden/specimens');
const MANIFEST = join(OUT, 'manifest.json');
const PREFIX = 'nullentry-';
const FORCE = process.argv.includes('--force');

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (manifest.specimens.some((s) => s.name.startsWith(PREFIX)) && !FORCE) {
  console.error(`${PREFIX}* が manifest にある。作り直すと基準のバイト列が変わる。--force が要る。`);
  process.exit(1);
}

const added = [];
const add = (name, text, axes) => {
  const buf = Buffer.from(text, 'latin1');
  writeFileSync(join(OUT, name), buf);
  added.push({
    name,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    axes,
  });
};

add(`${PREFIX}null-valued.pdf`, specimens.nullValuedEntry(), ['null-valued-entry', 'pdfa-declared']);
add(`${PREFIX}null-valued-invisible.pdf`, specimens.nullValuedInvisible(), [
  'null-valued-entry',
  'text-render-mode-3',
  'pdfa-declared',
]);
add(`${PREFIX}valued.pdf`, specimens.valuedEntry(), ['null-valued-entry-pair', 'pdfa-declared']);

manifest.specimens = [
  ...manifest.specimens.filter((s) => !s.name.startsWith(PREFIX)),
  ...added,
].sort((a, b) => a.name.localeCompare(b.name));
manifest.nullEntryBuiltAt = new Date().toISOString();
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`${added.length} 検体を足した（合計 ${manifest.specimens.length}）`);
for (const e of added) console.log(`  ${e.name}  ${e.bytes}B  [${e.axes.join(' ')}]`);
