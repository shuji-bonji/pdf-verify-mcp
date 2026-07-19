/**
 * verify_integrity core logic tests.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { analyzeIntegrity } from '../../src/services/verification-service.js';
import {
  appendIncrementalUpdate,
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
