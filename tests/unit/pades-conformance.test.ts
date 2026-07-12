/**
 * detect_pades_level / identify_conformance tests.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { PadesLevel } from '../../src/constants.js';
import { identifyConformance } from '../../src/services/conformance.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { detectPadesLevels } from '../../src/services/verification-service.js';
import { createSignedPdf, createTestIdentity, type TestIdentity } from '../helpers/signed-pdf.js';

let identity: TestIdentity;

beforeAll(async () => {
  identity = await createTestIdentity();
});

describe('detectPadesLevels', () => {
  it('CAdES signature without timestamp is PAdES B-B', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    const reports = await detectPadesLevels(parsed);

    expect(reports).toHaveLength(1);
    expect(reports[0].isPades).toBe(true);
    expect(reports[0].level).toBe(PadesLevel.B_B);
    expect(reports[0].evidence.hasSignatureTimestamp).toBe(false);
    expect(reports[0].evidence.hasDss).toBe(false);
  });

  it('adbe.pkcs7.detached is reported as non-PAdES', async () => {
    const pdf = await createSignedPdf(identity, { subFilter: 'adbe.pkcs7.detached' });
    const parsed = await parsePdfBytes(pdf);
    const reports = await detectPadesLevels(parsed);

    expect(reports).toHaveLength(1);
    expect(reports[0].isPades).toBe(false);
    expect(reports[0].level).toBeNull();
  });
});

describe('identifyConformance', () => {
  it('detects declared PDF/A and PDF/UA in XMP', async () => {
    const pdf = await createSignedPdf(identity, {
      xmp: { pdfaPart: '2', pdfaConformance: 'B', pdfuaPart: '1' },
    });
    const parsed = await parsePdfBytes(pdf);
    const report = identifyConformance(parsed);

    expect(report.hasXmp).toBe(true);
    expect(report.pdfA).toEqual({ part: '2', conformance: 'B' });
    expect(report.pdfUa).toEqual({ part: '1' });
    expect(report.pdfVersion).toBe('1.7');
  });

  it('reports absence of declarations', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    const report = identifyConformance(parsed);

    expect(report.pdfA).toBeNull();
    expect(report.pdfUa).toBeNull();
    expect(report.notes.join(' ')).toContain('identifies declared conformance only');
  });
});
