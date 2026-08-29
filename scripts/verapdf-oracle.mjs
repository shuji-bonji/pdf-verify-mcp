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
 * したがって面 3 は「**暗号化文書の平文の写しを、veraPDF が別実装の復号と同じに判定するか**」に
 * 縮む。基準には **qpdf --decrypt の出力**を使う —— verify と normativepdf を 1 行も共有しない
 * 復号器であり、同じ入力から作った平文どうしを veraPDF に並べて判定させる。
 *
 * 🔴 移行前の実装との突き合わせではない（撤去済み）。**別実装との突き合わせ**にしてあるので、
 * 旧実装が同じ誤りをしていても通らない。
 *
 * 参考として、暗号化していない元（`ua-plain.pdf`）の判定も 1 行目に出す。
 * これは基準ではない —— qpdf は暗号化のときに catalog へ `/Extensions` を足すので、
 * 暗号化を経た文書は元と同じにはならない。
 *
 * ## 使い方（veraPDF と qpdf のある機械で）
 *
 *   npm run build
 *   npm run check:verapdf-oracle
 *
 * 終了コード: 0 = 一致 / 1 = 食い違い / 2 = 道具が無い
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
try {
  execFileSync('qpdf', ['--version'], { stdio: 'pipe' });
} catch {
  console.error('qpdf が見つからない（基準の復号に要る）。');
  process.exit(2);
}
if (!existsSync(join(SPECIMENS, 'manifest.json'))) {
  console.error(`検体が無い: ${SPECIMENS}`);
  process.exit(2);
}
console.log(`veraPDF: ${vera.path} (${await veraPdfVersion(vera.path)})`);

const dir = mkdtempSync(join(tmpdir(), 'verapdf-oracle-'));
const manifest = JSON.parse(readFileSync(join(SPECIMENS, 'manifest.json'), 'utf8'));

/** veraPDF の判定を 1 行に畳む（compliant と、違反した規則の並び）。 */
const judge = async (path) => {
  const r = await runVeraPdf(vera.path, path, 'ua1');
  const rules = (r.violations ?? []).map((v) => v.ruleId ?? v.clause ?? '?').sort();
  return { line: `${r.compliant} [${rules.join(',')}]`, report: r };
};
const describe = (r) =>
  (r.violations ?? [])
    .map((v) => `      ${v.ruleId ?? v.clause}: ${String(v.description ?? '').slice(0, 120)}`)
    .join('\n');
/** §7.5.2 のヘッダ版（PDF/UA-1 6.1 は 1.0〜1.7 のいずれかであることを求める）。 */
const headerOf = (bytes) => /^%PDF-(\d+\.\d+)/.exec(Buffer.from(bytes.subarray(0, 16)).toString('latin1'))?.[1] ?? '?';

const plainPath = join(SPECIMENS, 'ua-plain.pdf');
if (existsSync(plainPath)) {
  const { line } = await judge(plainPath);
  console.log(`参考（ua-plain.pdf・暗号化していない元・${headerOf(new Uint8Array(readFileSync(plainPath)))}）: ${line}\n`);
}

let mismatched = 0;
let compared = 0;
for (const s of manifest.specimens) {
  if (!s.axes.includes('encrypted')) continue;
  const source = join(SPECIMENS, s.name);
  const bytes = new Uint8Array(readFileSync(source));

  // 基準: qpdf の復号（verify とも normativepdf とも 1 行も共有しない実装）
  const reference = join(dir, `qpdf-${s.name}`);
  try {
    execFileSync('qpdf', ['--decrypt', `--password=${s.password ?? ''}`, source, reference], {
      stdio: 'pipe',
    });
  } catch (e) {
    console.log(`  🔴 NG ${s.name.padEnd(28)} qpdf --decrypt が失敗した`);
    mismatched += 1;
    continue;
  }

  const ours = await decryptedCopy(bytes, s.password ?? '');
  if (!ours) {
    console.log(`  🔴 NG ${s.name.padEnd(28)} 平文の写しを作れない`);
    mismatched += 1;
    continue;
  }
  const oursPath = join(dir, `ours-${s.name}`);
  writeFileSync(oursPath, ours);

  let qpdfCheck = 'ok';
  try {
    execFileSync('qpdf', ['--check', oursPath], { stdio: 'pipe' });
  } catch {
    qpdfCheck = 'NG';
  }

  const a = await judge(reference);
  const b = await judge(oursPath);
  const same = a.line === b.line;
  compared += 1;
  if (!same) mismatched += 1;
  console.log(
    `  ${same ? 'OK  ' : '🔴 NG'} ${s.name.padEnd(28)} qpdf --check=${qpdfCheck} ` +
      `header ${headerOf(new Uint8Array(readFileSync(reference)))}/${headerOf(ours)}`,
  );
  console.log(`        qpdf の復号: ${a.line}`);
  console.log(`        こちらの写し: ${b.line}`);
  if (!same) {
    console.log(describe(a.report));
    console.log('      ----');
    console.log(describe(b.report));
  }
}

console.log(
  mismatched === 0
    ? `\n${compared} 件とも、qpdf の復号と同じ判定を受けた（面 3 充足）`
    : `\n🔴 ${mismatched} 件が基準と食い違う`,
);
process.exit(mismatched === 0 ? 0 : 1);
