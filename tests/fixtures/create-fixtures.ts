/**
 * Generate reproducible test fixture PDFs under tests/fixtures/generated/.
 * Run with: npm run test:fixtures
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLinearizedPdf } from '../helpers/linearized-pdf.js';
import {
  appendIncrementalUpdate,
  appendObjectRevision,
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

  // Three well-formed incremental updates after signing, one per change kind:
  // an object added, then rewritten, then freed (Issue #8 / UC-10).
  const addedAfterSigning = appendObjectRevision(signed, {
    objects: [
      {
        objectNumber: 8,
        body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /Rect [ 100 700 200 720 ] /V (1,000) >>',
      },
    ],
  });
  const rewrittenAfterSigning = appendObjectRevision(addedAfterSigning, {
    objects: [
      {
        objectNumber: 8,
        body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /Rect [ 100 700 200 720 ] /V (9,000,000) >>',
      },
      { objectNumber: 9, body: '<< /Length 10 >>\nstream\nBT /F1 ET\nendstream' },
    ],
  });
  await writeFile(
    join(outDir, 'appended-objects.pdf'),
    appendObjectRevision(rewrittenAfterSigning, { freed: [9] }),
  );

  const certified = await createSignedPdf(identity, { docMdpPermission: 1 });
  await writeFile(join(outDir, 'certified-p1.pdf'), certified);
  await writeFile(join(outDir, 'certified-p1-modified.pdf'), appendIncrementalUpdate(certified));

  const legacy = await createSignedPdf(identity, { subFilter: 'adbe.pkcs7.detached' });
  await writeFile(join(outDir, 'legacy-adbe.pdf'), legacy);

  // The one shape no other fixture has: two cross-reference sections for a
  // single save (ISO 32000-2 Annex F), which is what makes `revisionCount`
  // disagree with the revision list. Unsigned — the chain is what it is for.
  await writeFile(join(outDir, 'linearized.pdf'), createLinearizedPdf());

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
