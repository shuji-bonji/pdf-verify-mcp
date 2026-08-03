/**
 * verify_integrity core logic tests.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { analyzeIntegrity } from '../../src/services/verification-service.js';
import {
  appendIncrementalUpdate,
  appendObjectRevision,
  createSignedPdf,
  createTestIdentity,
  type TestIdentity,
} from '../helpers/signed-pdf.js';

let identity: TestIdentity;
let signedPdf: Uint8Array;

beforeAll(async () => {
  identity = await createTestIdentity();
  signedPdf = await createSignedPdf(identity);
});

describe('analyzeIntegrity', () => {
  it('clean signed PDF: one revision, signature covers file', async () => {
    const parsed = await parsePdfBytes(signedPdf);
    const report = analyzeIntegrity(parsed);

    expect(report.signatureCount).toBe(1);
    expect(report.revisionCount).toBe(1);
    expect(report.incrementalUpdateCount).toBe(0);
    expect(report.lastSignatureCoversFile).toBe(true);
    expect(report.signaturesWithLaterChanges).toHaveLength(0);
  });

  it('detects bytes appended after signing', async () => {
    const appended = appendIncrementalUpdate(signedPdf);
    const parsed = await parsePdfBytes(appended);
    const report = analyzeIntegrity(parsed);

    expect(report.revisionCount).toBe(2);
    expect(report.incrementalUpdateCount).toBe(1);
    expect(report.lastSignatureCoversFile).toBe(false);
    expect(report.signaturesWithLaterChanges).toHaveLength(1);
    expect(report.signaturesWithLaterChanges[0].bytesAfterSignedRange).toBeGreaterThan(0);
  });

  it('reports DocMDP certification and violation', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 1 });

    const cleanReport = analyzeIntegrity(await parsePdfBytes(certified));
    expect(cleanReport.certification?.permission).toBe(1);
    expect(cleanReport.certification?.violatedByLaterChanges).toBe(false);

    const modified = appendIncrementalUpdate(certified);
    const modifiedReport = analyzeIntegrity(await parsePdfBytes(modified));
    expect(modifiedReport.certification?.violatedByLaterChanges).toBe(true);
    expect(modifiedReport.certification?.laterChangesAppearLtvOnly).toBe(false);
  });

  it('does not flag P=1 when later changes appear to be DSS/DTS (ISO 32000-2 §12.8.2.2)', async () => {
    // Certified (P=1) document that carries a DSS: later incremental updates
    // are treated as the permitted DSS/document-timestamp exception.
    const certified = await createSignedPdf(identity, {
      docMdpPermission: 1,
      dss: { certs: [new Uint8Array(identity.certificate.toSchema(true).toBER(false))] },
    });

    const modified = appendIncrementalUpdate(certified);
    const report = analyzeIntegrity(await parsePdfBytes(modified));
    expect(report.certification?.permission).toBe(1);
    expect(report.certification?.violatedByLaterChanges).toBe(false);
    expect(report.certification?.laterChangesAppearLtvOnly).toBe(true);
    expect(report.notes.join(' ')).toMatch(/12\.8\.2\.2/);
  });
});

/**
 * DocMDP against what P actually grants (ISO 32000-2 Table 257), not only P=1.
 *
 * 🔴 Until 0.14.0 the check began with `permission === 1`, so **P=2 and P=3
 * could never be violated**. The three tests below are the same appended
 * annotation judged at each permission — the discriminating triple.
 */
describe('analyzeIntegrity — DocMDP P=2 / P=3', () => {
  const annotation = {
    objectNumber: 8,
    body: '<< /Type /Annot /Subtype /Text /Rect [ 400 700 420 720 ] /Contents (added after signing) >>',
  };
  const widget = {
    objectNumber: 8,
    body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /Rect [ 100 700 200 720 ] /V (1,000) >>',
  };

  it('flags an annotation appended to a P=2 document (Table 257 grants it only from P=3)', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 2 });
    const report = analyzeIntegrity(
      await parsePdfBytes(appendObjectRevision(certified, { objects: [annotation] })),
    );
    expect(report.certification?.permission).toBe(2);
    expect(report.certification?.violationAssessment).toBe('violated');
    expect(report.certification?.violatedByLaterChanges).toBe(true);
    expect(report.certification?.assessmentReason).toMatch(/outside what P=2 permits/);
  });

  it('does NOT flag the same annotation on a P=3 document', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 3 });
    const report = analyzeIntegrity(
      await parsePdfBytes(appendObjectRevision(certified, { objects: [annotation] })),
    );
    expect(report.certification?.permission).toBe(3);
    expect(report.certification?.violationAssessment).toBe('permitted');
    expect(report.certification?.violatedByLaterChanges).toBe(false);
  });

  it('does NOT flag a form-field widget on a P=2 document ("filling in forms")', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 2 });
    const report = analyzeIntegrity(
      await parsePdfBytes(appendObjectRevision(certified, { objects: [widget] })),
    );
    expect(report.certification?.violationAssessment).toBe('permitted');
  });

  it('flags a page content stream on a P=3 document (no P value permits it)', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 3 });
    const report = analyzeIntegrity(
      await parsePdfBytes(
        appendObjectRevision(certified, {
          objects: [
            { objectNumber: 8, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
          ],
        }),
      ),
    );
    expect(report.certification?.violationAssessment).toBe('violated');
  });

  it('reports indeterminate — not permitted — when a changed object cannot be typed', async () => {
    // An object whose kind cannot be read must not be counted as harmless.
    // "Could not be disproved" is a different statement from "is fine".
    const certified = await createSignedPdf(identity, { docMdpPermission: 2 });
    const report = analyzeIntegrity(
      await parsePdfBytes(
        appendObjectRevision(certified, { objects: [{ objectNumber: 8, body: '42' }] }),
      ),
    );
    expect(report.certification?.violationAssessment).toBe('indeterminate');
    // 🔴 The boolean collapses indeterminate to false. That is exactly why the
    // three-valued field exists, and why callers must not read the boolean alone.
    expect(report.certification?.violatedByLaterChanges).toBe(false);
    expect(report.notes.join(' ')).toMatch(/not a pass/);
  });

  it('reports indeterminate when bytes were appended but the chain cannot be walked', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 2 });
    // appendIncrementalUpdate writes startxref 0 — the newest section is unreadable
    const report = analyzeIntegrity(await parsePdfBytes(appendIncrementalUpdate(certified)));
    expect(report.certification?.violationAssessment).toBe('indeterminate');
  });
});

/**
 * Issue #8 / family gap G-B — the object-level view of the update chain.
 * Every assertion here is about *observation*: no verdict may move because of
 * it, which the last test in this block pins down explicitly.
 */
describe('analyzeIntegrity — object-level revision diff', () => {
  /** signed → add obj 8 → rewrite obj 8 and add obj 9 → free obj 9 */
  async function buildChain(): Promise<Uint8Array> {
    const added = appendObjectRevision(signedPdf, {
      objects: [
        {
          objectNumber: 8,
          body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /Rect [ 100 700 200 720 ] /V (1,000) >>',
        },
      ],
    });
    const rewritten = appendObjectRevision(added, {
      objects: [
        {
          objectNumber: 8,
          body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /Rect [ 100 700 200 720 ] /V (9,000,000) >>',
        },
        { objectNumber: 9, body: '<< /Length 10 >>\nstream\nBT /F1 ET\nendstream' },
      ],
    });
    return appendObjectRevision(rewritten, { freed: [9] });
  }

  it('names the objects each incremental update added, rewrote and freed', async () => {
    const report = analyzeIntegrity(await parsePdfBytes(await buildChain()));
    const revisions = report.revisions;
    expect(revisions).not.toBeNull();
    if (!revisions) return;
    expect(revisions).toHaveLength(4);

    // The original revision has nothing older to compare against.
    expect(revisions[0].changes).toBeNull();

    expect(revisions[1].changes).toEqual([
      expect.objectContaining({
        objectNumber: 8,
        change: 'added',
        type: 'Annot',
        subtype: 'Widget',
        bookkeeping: false,
      }),
    ]);
    expect(revisions[2].changes).toEqual([
      expect.objectContaining({ objectNumber: 8, change: 'modified', type: 'Annot' }),
      expect.objectContaining({ objectNumber: 9, change: 'added' }),
    ]);
    expect(revisions[3].changes).toEqual([
      expect.objectContaining({ objectNumber: 9, change: 'freed' }),
    ]);
  });

  it('reads the role of a changed object from that revision, not from pdf-lib', async () => {
    const report = analyzeIntegrity(await parsePdfBytes(await buildChain()));
    const widget = report.revisions?.[1].changes?.[0];
    expect(widget?.role).toMatch(/form field widget/);
    // Object 9 is a bare stream: no /Type to read, so the role is a guess from
    // the keys and must stay a guess.
    const stream = report.revisions?.[2].changes?.find((c) => c.objectNumber === 9);
    expect(stream?.type).toBeNull();
    expect(stream?.role).toMatch(/stream/);
  });

  it('shortlists the objects written after the last signed range', async () => {
    const report = analyzeIntegrity(await parsePdfBytes(await buildChain()));
    const numbers = report.objectChangesAfterLastSignature.map((c) => c.objectNumber);
    // Every revision after the first was appended past the signed range.
    expect(numbers).toEqual([8, 8, 9, 9]);
  });

  it('says "not determined" rather than "unchanged" when the chain is unwalkable', async () => {
    // appendIncrementalUpdate writes `startxref 0`, which points nowhere. The
    // chain is then entered from an older section and the trailing bytes are
    // not represented — that has to be said out loud.
    const report = analyzeIntegrity(await parsePdfBytes(appendIncrementalUpdate(signedPdf)));
    expect(report.notes.join(' ')).toMatch(/does not point at a parseable cross-reference section/);
  });

  it('leaves every existing verdict untouched', async () => {
    const chain = await buildChain();
    const report = analyzeIntegrity(await parsePdfBytes(chain));
    // The same facts as before the diff existed: appending objects after a
    // signature is legal, so nothing about the signature's status changes.
    expect(report.signatureCount).toBe(1);
    expect(report.lastSignatureCoversFile).toBe(false);
    expect(report.certification).toBeNull();
    expect(report.signaturesWithLaterChanges).toHaveLength(1);
  });
});
