#!/usr/bin/env node
/**
 * 受入の面 3（独立オラクル）—— **veraPDF のある機械で回す**（device_bash には無い）。
 *
 * ## 何を測るのか
 *
 * B2 が veraPDF に渡すファイルを変えるのは **1 か所だけ**である（実測・§13）:
 *
 * ```
 * PDF/A  : runVeraPdf(veraPath, filePath, …)          ← 常に元のファイル。B2 は触らない
 * PDF/UA : runVeraPdf(veraPath, validationPath, …)    ← 暗号化文書のときだけ平文の写し
 * ```
 *
 * したがって面 3 は「暗号化文書の平文の写しを、veraPDF が元の平文と同じに判定するか」に
 * 縮む。`.golden/specimens/ua-enc-*.pdf` は全部 `ua-plain.pdf` を qpdf で暗号化したものなので、
 * **写しの判定が `ua-plain.pdf` の判定と一致すれば、書き直しは veraPDF が見る面を保っている。**
 *
 * 🔴 移行前の実装との突き合わせではない（撤去済み）。**同じ文書の暗号化前と後**を比べる、
 * より強い形にしてある —— 旧実装が同じ誤りをしていても、こちらは通らない。
 *
 * ## 使い方（Mac 側で）
 *
 *   npm run build
 *   node scripts/verapdf-oracle.mjs
 *
 * 終了コード: 0 = 一致 / 1 = 食い違い / 2 = veraPDF が見つからない
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPECIMENS = join(ROOT, '.golden/specimens');

const { resolveVeraPdf, runVeraPdf, veraPdfVersion } = await import(
  join(ROOT, 'dist/services/verapdf.js')
);
const { decryptedCopy } = await import(join(ROOT, 'dist/services/plaintext-copy.js'));

const vera = await resolveVeraPdf();
if (!vera?.path) {
  console.error('veraPDF が見つからない。PDF_VERIFY_VERAPDF か PATH に置いて回すこと。');
  process.exit(2);
}
console.log(`veraPDF: ${vera.path} (${await veraPdfVersion(vera.path)})`);

if (!existsSync(join(SPECIMENS, 'ua-plain.pdf'))) {
  console.error(`検体が無い: ${SPECIMENS}`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'verapdf-oracle-'));
const manifest = JSON.parse(readFileSync(join(SPECIMENS, 'manifest.json'), 'utf8'));

/** veraPDF の判定を 1 行に畳む（compliant と、違反した規則の並び）。 */
const judge = async (path) => {
  const r = await runVeraPdf(vera.path, path, 'ua1');
  const rules = (r.violations ?? []).map((v) => v.ruleId ?? v.clause ?? '?').sort();
  return `${r.compliant} [${rules.join(',')}]`;
};

const reference = await judge(join(SPECIMENS, 'ua-plain.pdf'));
console.log(`基準（ua-plain.pdf・暗号化していない元）: ${reference}\n`);

let mismatched = 0;
for (const s of manifest.specimens) {
  if (!s.axes.includes('encrypted')) continue;
  const bytes = new Uint8Array(readFileSync(join(SPECIMENS, s.name)));
  const plain = await decryptedCopy(bytes, s.password ?? '');
  if (!plain) {
    console.log(`  🔴 ${s.name.padEnd(28)} 平文の写しを作れない`);
    mismatched += 1;
    continue;
  }
  const out = join(dir, `${s.name}`);
  writeFileSync(out, plain);
  // qpdf も通す（構文と xref の穴は veraPDF の前に出る）
  let qpdf = 'ok';
  try {
    execFileSync('qpdf', ['--check', out], { stdio: 'pipe' });
  } catch (e) {
    qpdf = 'NG';
  }
  const verdict = await judge(out);
  const same = verdict === reference;
  if (!same) mismatched += 1;
  console.log(`  ${same ? 'OK  ' : '🔴 NG'} ${s.name.padEnd(28)} qpdf=${qpdf} ${verdict}`);
}

console.log(
  mismatched === 0
    ? '\n暗号化検体の平文の写しは、暗号化していない元と同じ判定を受けた（面 3 充足）'
    : `\n🔴 ${mismatched} 件が基準と食い違う`,
);
process.exit(mismatched === 0 ? 0 : 1);
