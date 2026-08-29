/**
 * 相互参照チェーンの止まり方の検体を作り、`.golden/specimens/manifest.json` に足す。
 *
 * 0.19.0 の基準を採ったとき、`XrefChainStop` の 5 値のうち **3 値しか踏まれていなかった**
 * （complete 2,938 / unreadable 7 / prev-zero 1 / cyclic 0 / malformed 0）。
 * `DocumentScope` を出力に載せる前に、載せる項目が動くところを見ておくための集合。
 * 計画は `docs/handoff/scope-in-output.md` の S0。
 *
 * 🔴 `golden-specimens.mjs` は走らせないこと —— あれは 21 検体を作り直し、
 * pdf-lib の `save()` が ModDate を書くので撤去前のバイト列が変わる。
 * ここは **足すだけ**で、既存の検体には触らない。
 *
 * 本文の組み立ては `scripts/lib/xref-specimen-builder.mjs`。
 * 同じものを `tests/unit/document-scope.test.ts` も読む —— 検体とテストが
 * 別々の作り方をしていると、片方だけ狙いを外しても気づけない。
 *
 * 使い方: node scripts/golden-specimens-xref.mjs [--force]
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { specimens } from './lib/xref-specimen-builder.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, '.golden/specimens');
const MANIFEST = join(OUT, 'manifest.json');
const PREFIX = 'xref-';
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

add(`${PREFIX}cyclic.pdf`, specimens.cyclic(), ['xref-chain', 'cyclic']);
add(`${PREFIX}malformed-prev.pdf`, specimens.malformed(), ['xref-chain', 'malformed']);
add(`${PREFIX}unreadable-table.pdf`, specimens.unreadableTable(), ['xref-chain', 'reconstructed']);

manifest.specimens = [
  ...manifest.specimens.filter((s) => !s.name.startsWith(PREFIX)),
  ...added,
].sort((a, b) => a.name.localeCompare(b.name));
manifest.xrefBuiltAt = new Date().toISOString();
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`${added.length} 検体を足した（合計 ${manifest.specimens.length}）`);
for (const e of added) console.log(`  ${e.name}  ${e.bytes}B  [${e.axes.join(' ')}]`);
