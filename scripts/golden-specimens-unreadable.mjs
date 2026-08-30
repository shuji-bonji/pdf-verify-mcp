#!/usr/bin/env node
/**
 * 「どうやっても読めない文書」の検体を 2 件作り、`manifest.json` に足す。
 *
 * **なぜ要るか**: `@normativepdf/recover` 0.1.2 で `ua-broken-startxref.pdf` が
 * 読めるようになり、**コーパスから `isError` の検体が 1 件も無くなった**。
 * 計器（`scripts/golden.mjs`）の T-3 には「読めない -> 読めた」を確かめる検査が
 * あり、壊す先を `isError` の検体から選ぶ。0 件になると、その検査は
 * 「通った」のではなく**何も測らなくなる**（実際には落ちた）。
 *
 * 読めるようになったのは良いことである。だからこそ、**読めない側の軸を
 * 検体で持ち直す**。回復方針で読めてしまっては軸にならないので、
 * 回復の入口をすべて塞いだ形にする:
 *
 *   ua-no-objects.pdf     ヘッダはあるが `N G obj` が 1 つも無い。
 *                         走査する対象が無いので相互参照表を組み直せない
 *   ua-no-header.pdf      `%PDF-` が無く、中身もオブジェクトではない
 *
 * 空振り検査の対は、既存の `ua-plain.pdf`（同じ大きさの、普通に読める文書）が担う。
 *
 * 🔴 `golden-specimens.mjs` は走らせないこと —— あれは 21 検体を作り直す。
 * ここは **足すだけ**で、既存の検体には触らない。
 *
 * 使い方: node scripts/golden-specimens-unreadable.mjs [--force]
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, '.golden/specimens');
const MANIFEST = join(OUT, 'manifest.json');
const PREFIX = 'ua-no-';
const FORCE = process.argv.includes('--force');

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (manifest.specimens.some((s) => s.name.startsWith(PREFIX)) && !FORCE) {
  console.error(`${PREFIX}* が manifest にある。作り直すと基準のバイト列が変わる。--force が要る。`);
  process.exit(1);
}

/** ヘッダと `%%EOF` はあるが、間接オブジェクトも相互参照節も 1 つも無い。 */
const noObjects = ['%PDF-1.7', '%\x81\x81\x81\x81', '', '% この文書には間接オブジェクトが 1 つも無い', '', '%%EOF', ''].join('\n');

/** `%PDF-` すら無い。拡張子だけが .pdf のファイル。 */
const noHeader = ['This is not a PDF.', 'It has no header, no objects and no cross-reference section.', ''].join('\n');

const added = [];
const add = (name, text, axes) => {
  const buf = Buffer.from(text, 'latin1');
  writeFileSync(join(OUT, name), buf);
  added.push({ name, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), axes });
};

add(`${PREFIX}objects.pdf`, noObjects, ['unreadable', 'no-indirect-objects']);
add(`${PREFIX}header.pdf`, noHeader, ['unreadable', 'no-header']);

manifest.specimens = [
  ...manifest.specimens.filter((s) => !s.name.startsWith(PREFIX)),
  ...added,
].sort((a, b) => a.name.localeCompare(b.name));
manifest.unreadableBuiltAt = new Date().toISOString();
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`${added.length} 検体を足した（合計 ${manifest.specimens.length}）`);
for (const e of added) console.log(`  ${e.name}  ${e.bytes}B  [${e.axes.join(' ')}]`);
