#!/usr/bin/env node
/**
 * L0 の署名側の検体を作り、`.golden/specimens/manifest.json` に足す（B2）。
 *
 * `tests/fixtures/generated/` にあるのは B-B と改ざん・増分更新だけで、
 * detect_pades_level の軸（署名タイムスタンプ・DSS・文書タイムスタンプ）が 1 形しか無い。
 * リポジトリ自身の `tests/helpers/signed-pdf.ts` で作る —— 別実装を書かない。
 *
 * device_bash では tsc が動かないので、node の型剥がし（--experimental-strip-types）で
 * .ts を直接読み、`../../src/*.js` の解決だけ dist へ付け替える
 * （`.golden/tools/src-to-dist-loader.mjs`）。
 *
 * 使い方:
 *   node --experimental-strip-types --import ./.golden/tools/register-loader.mjs \
 *        scripts/golden-specimens-pades.mjs [--force]
 *
 * 🔴 一度作ったら作り直さない（鍵も証明書も毎回変わる）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCrl,
  createSignedPdf,
  createTestCa,
  createTestIdentity,
} from '../tests/helpers/signed-pdf.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, '.golden/specimens');
const MANIFEST = join(OUT, 'manifest.json');
const FORCE = process.argv.includes('--force');

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (manifest.specimens.some((s) => s.name.startsWith('pades-')) && !FORCE) {
  console.error('署名検体は既にある。作り直すと撤去前のバイト列が変わる。--force が要る。');
  process.exit(2);
}

const identity = await createTestIdentity();
const ca = await createTestCa();
const tsa = await createTestIdentity('pdf-verify-mcp test TSA');
const crl = await createCrl(ca);

const der = (id) => new Uint8Array(id.certificate.toSchema().toBER(false));

const built = [
  ['pades-b-b.pdf', {}, ['signature', 'pades-b-b']],
  ['pades-b-t.pdf', { tsa }, ['signature', 'pades-b-t', 'signature-timestamp']],
  [
    'pades-b-lt.pdf',
    { tsa, dss: { certs: [der(identity), der(tsa), der(ca)], crls: [crl] } },
    ['signature', 'pades-b-lt', 'signature-timestamp', 'dss'],
  ],
  [
    'pades-doctimestamp.pdf',
    { subFilter: 'ETSI.RFC3161', tsa },
    ['signature', 'document-timestamp'],
  ],
  [
    'pades-doctimestamp-dss.pdf',
    { subFilter: 'ETSI.RFC3161', tsa, dss: { certs: [der(tsa), der(ca)], crls: [crl] } },
    ['signature', 'document-timestamp', 'dss'],
  ],
  ['pades-non-pades.pdf', { subFilter: 'adbe.pkcs7.detached' }, ['signature', 'non-pades']],
  [
    'pades-cms-broken.pdf',
    {
      mutateCms: (cms) => {
        const copy = cms.slice();
        copy[copy.length - 5] ^= 0xff;
        return copy;
      },
    },
    ['signature', 'cms-broken'],
  ],
  [
    'pades-docmdp-p3.pdf',
    { docMdpPermission: 3 },
    ['signature', 'certification', 'docmdp-p3'],
  ],
  [
    'pades-xmp-pdfa2b.pdf',
    { xmp: { pdfaPart: '2', pdfaConformance: 'B', pdfuaPart: '1' } },
    ['signature', 'pdfa-declared', 'pdfua-declared'],
  ],
];

const added = [];
for (const [name, options, axes] of built) {
  const bytes = await createSignedPdf(identity, options);
  writeFileSync(join(OUT, name), bytes);
  const buf = readFileSync(join(OUT, name));
  added.push({
    name,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    axes,
  });
}

manifest.specimens = [...manifest.specimens.filter((s) => !s.name.startsWith('pades-')), ...added]
  .sort((a, b) => a.name.localeCompare(b.name));
manifest.padesBuiltAt = new Date().toISOString();
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${added.length} 検体を足した（合計 ${manifest.specimens.length}）`);
for (const e of added) console.log(`  ${e.name}  ${e.bytes}B  [${e.axes.join(' ')}]`);
