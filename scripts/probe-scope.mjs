/**
 * DocumentScope の 11 項目が、いまの検体集合でどれだけ動くかを数える。
 * 出力に載せるかを決める前に、「載せた項目が動くのか」を測るためのもの。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDocument } from '@normativepdf/recover';

const ROOT = resolve(import.meta.dirname, "..");
const SETS = [
  join(ROOT, '.golden/specimens'),
  join(ROOT, 'tests/fixtures/generated'),
  resolve(ROOT, '../../lib/normativepdf/corpus/veraPDF-corpus'),
  resolve(ROOT, '../../lib/normativepdf/corpus/pdf20examples'),
  resolve(ROOT, '../../lib/normativepdf/corpus/_wout'),
];
const walk = (d, out = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (n.toLowerCase().endsWith('.pdf')) out.push(p);
  }
  return out;
};
const files = SETS.flatMap((d) => { try { return walk(d); } catch { return []; } });

const count = {};
const bump = (k, v) => ((count[k] ??= {})[String(v)] = ((count[k] ?? {})[String(v)] ?? 0) + 1);
let opened = 0, threw = 0;
const examples = {};

for (const f of files) {
  let scope;
  try {
    scope = (await openDocument(new Uint8Array(readFileSync(f)))).scope;
    opened++;
  } catch {
    threw++;
    continue;
  }
  for (const k of ['recovered', 'chainStop', 'newestSectionUnreadable', 'continuedPastStop', 'reconstructed', 'encrypted', 'authenticated']) {
    const v = k === 'chainStop' ? scope.chainStop.kind : scope[k];
    bump(k, v);
    if (v === true || (k === 'chainStop' && v !== 'complete')) (examples[`${k}=${v}`] ??= []).push(f.replace(ROOT, ''));
  }
  bump('filledFromScan>0', scope.filledFromScan > 0);
  bump('refusal!=null', scope.refusal !== null);
  bump('sections', scope.sections > 3 ? '4+' : scope.sections);
}

console.log(`検体 ${files.length} / 開けた ${opened} / 例外 ${threw}\n`);
for (const [k, v] of Object.entries(count)) console.log(k.padEnd(24), JSON.stringify(v));
console.log('\n真になった検体（先頭 3 件ずつ）:');
for (const [k, v] of Object.entries(examples)) console.log(' ', k.padEnd(28), v.slice(0, 3).join(' | '));
