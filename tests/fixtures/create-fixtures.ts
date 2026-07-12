/**
 * Generate reproducible test fixture PDFs under tests/fixtures/generated/.
 * Run with: npm run test:fixtures
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendIncrementalUpdate,
  createSignedPdf,
  createTestIdentity,
  tamperSignedPdf,
} from '../helpers/signed-pdf.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'generated');

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const identity = await createTestIdentity();

  const signed = await createSignedPdf(identity);
  await writeFile(join(outDir, 'signed.pdf'), signed);
  await writeFile(join(outDir, 'tampered.pdf'), tamperSignedPdf(signed));
  await writeFile(join(outDir, 'appended.pdf'), appendIncrementalUpdate(signed));

  const certified = await createSignedPdf(identity, { docMdpPermission: 1 });
  await writeFile(join(outDir, 'certified-p1.pdf'), certified);
  await writeFile(join(outDir, 'certified-p1-modified.pdf'), appendIncrementalUpdate(certified));

  const legacy = await createSignedPdf(identity, { subFilter: 'adbe.pkcs7.detached' });
  await writeFile(join(outDir, 'legacy-adbe.pdf'), legacy);

  const pdfa = await createSignedPdf(identity, {
    xmp: { pdfaPart: '2', pdfaConformance: 'B', pdfuaPart: '1' },
  });
  await writeFile(join(outDir, 'pdfa-declared.pdf'), pdfa);

  console.error(`fixtures written to ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
