#!/usr/bin/env node
/**
 * 埋め込まれていないフォントが、**どのテキストレンダリングモードで文字を出しているか**を数える。
 *
 * `fonts-embedded` はいまフォント辞書を数え上げているだけで、使われ方を見ていない。
 * PDF/A はモード 3（不可視）でしか使われないフォントを埋め込み要求から外している
 * （veraPDF の `6-2-10-4-1-t01-{pass,fail}-a.pdf` は `3 Tr` の 1 演算子だけが違う対）。
 * 規則を直す前に、**その形がどれだけ在るか**を測る。
 *
 * 分類（🔴 **1 つに畳まない**）:
 *   visible        —— 1 回でもモード 3 以外で出している。埋め込みが要る
 *   invisible-only —— 出しているのはモード 3 だけ。PDF/A の除外に当たりうる
 *   unused         —— どのページのコンテンツでも文字を出していない
 *   unknown        —— コンテンツを読めなかった / 名前を解決できなかった / 深すぎた。
 *                     **観測できていない。invisible-only に寄せない**
 *
 * 使い方:
 *   node scripts/probe-font-usage.mjs --self-check   # 既知の対で当たることを先に見る
 *   node scripts/probe-font-usage.mjs [--offset N] [--limit N]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asDict, get, has, nameOf, openDocument, resolved } from '@normativepdf/recover';
import { collectFontUsage } from '../dist/services/content-font-usage.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SETS = [
  join(ROOT, '.golden/specimens'),
  join(ROOT, 'tests/fixtures/generated'),
  resolve(ROOT, '../../lib/normativepdf/corpus/veraPDF-corpus'),
  resolve(ROOT, '../../lib/normativepdf/corpus/pdf20examples'),
  resolve(ROOT, '../../lib/normativepdf/corpus/_wout'),
];

/** `pdfa-validator.ts` の fonts-embedded と同じ絞り方にする（違うものを測らないため） */
function isCandidate(dict) {
  if (nameOf(get(dict, 'Type')) !== 'Font') return false;
  const subtype = nameOf(get(dict, 'Subtype')) ?? '';
  return subtype !== 'Type0' && subtype !== 'Type3';
}

async function classify(file) {
  const { doc } = await openDocument(new Uint8Array(readFileSync(file)));
  // 🔴 規則が使うのと**同じ実装**を読む（dist）。probe だけが別の写しを持つと、
  // 測ったものと出荷したものが違ってくる。
  const { usage, incomplete, reasons } = await collectFontUsage(doc);

  const fonts = [];
  for (const [font, modes] of usage) {
    if (!isCandidate(font)) continue;
    const descriptor = asDict(await resolved(doc, get(font, 'FontDescriptor')));
    const embedded =
      descriptor !== null &&
      (has(descriptor, 'FontFile') || has(descriptor, 'FontFile2') || has(descriptor, 'FontFile3'));
    if (embedded) continue;
    const visible = [...modes].some((m) => m !== 3);
    fonts.push({
      name: nameOf(get(font, 'BaseFont')) ?? '(unknown)',
      modes: [...modes].sort(),
      state: visible ? 'visible' : 'invisible-only',
    });
  }
  if (fonts.some((f) => f.state === 'visible')) return { verdict: 'visible', fonts, incomplete, reasons };
  if (incomplete) return { verdict: 'unknown', fonts, incomplete, reasons };
  if (fonts.length === 0) return { verdict: 'unused', fonts, incomplete, reasons };
  return { verdict: 'invisible-only', fonts, incomplete, reasons };
}

/** 🔴 走らせる前に、当たる入力で当たることを見る。0 件の報告を信じないための対。 */
async function selfCheck() {
  const base = resolve(
    ROOT,
    '../../lib/normativepdf/corpus/veraPDF-corpus/PDF_A-4/6.2 Graphics/6.2.10 Fonts/6.2.10.4 Embedding/6.2.10.4.1 General',
  );
  const cases = [
    ['veraPDF test suite 6-2-10-4-1-t01-pass-a.pdf', 'invisible-only'],
    ['veraPDF test suite 6-2-10-4-1-t01-fail-a.pdf', 'visible'],
    ['veraPDF test suite 6-2-10-4-1-t01-fail-b.pdf', 'visible'],
  ];
  let failed = 0;
  console.log('自己検査（veraPDF が pass / fail に分ける対で、こちらも分かれるか）:');
  for (const [name, want] of cases) {
    const r = await classify(join(base, name));
    const ok = r.verdict === want;
    if (!ok) failed += 1;
    console.log(
      `  ${ok ? 'OK  ' : '🔴 NG'} ${name.slice(-14)}  期待 ${want.padEnd(14)} 実測 ${r.verdict}` +
        `  ${r.fonts.map((f) => `${f.name}:[${f.modes.join(',')}]`).join(' ')}`,
    );
  }
  console.log(failed ? `\n🔴 ${failed} 件外した。この計器で数を出さないこと。` : '\n3 件とも分かれた。');
  return failed;
}

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
if (argv.includes('--self-check')) process.exit((await selfCheck()) ? 2 : 0);

const num = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i === -1 ? dflt : Number(argv[i + 1]);
};
let files;
const listFlag = argv.indexOf('--from');
if (listFlag !== -1) {
  // ゴールデンのキー（`{set}/相対パス`）を実パスに戻して、その集合だけ測る
  const roots = Object.fromEntries(SETS.map((d) => [d.endsWith('generated') ? 'fixtures' : d.endsWith('veraPDF-corpus') ? 'veraPDF' : d.split('/').pop(), d]));
  files = readFileSync(argv[listFlag + 1], 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = /^\{([^}]+)\}\/(.*)$/.exec(line);
      return m ? join(roots[m[1]] ?? '', m[2]) : line;
    });
} else {
  files = SETS.filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })
    .flatMap(listPdfs);
}
const picked = files.slice(num('--offset', 0), num('--offset', 0) + num('--limit', Infinity));

const tally = { visible: 0, 'invisible-only': 0, unused: 0, unknown: 0 };
const notVisible = [];
let threw = 0;
for (const f of picked) {
  let r;
  try {
    r = await classify(f);
  } catch (e) {
    threw += 1;
    continue;
  }
  tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
  if (argv.includes('--show-unused') && r.verdict === 'unused') {
    notVisible.push(`unused  ${f.replace(ROOT, '.')}`);
  }
  if (r.verdict === 'invisible-only' || (r.verdict === 'unknown' && r.fonts.length > 0)) {
    notVisible.push(`${r.verdict}  ${f.replace(ROOT, '.')}  ${r.fonts.map((x) => `${x.name}:[${x.modes.join(',')}]`).join(' ')}`);
  }
}
console.log(`検体 ${picked.length}（offset ${num('--offset', 0)}）/ 🔴 例外で落ちた ${threw}`);
console.log(`  埋め込まれていないフォントの使われ方:`);
for (const [k, v] of Object.entries(tally)) console.log(`    ${k.padEnd(16)} ${v}`);
if (notVisible.length) {
  console.log(`\n  visible でないもの（${notVisible.length} 件）:`);
  for (const line of notVisible.slice(0, 40)) console.log(`    ${line}`);
}
