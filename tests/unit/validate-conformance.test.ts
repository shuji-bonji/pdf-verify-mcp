/**
 * v0.3: PDF/A conformance validation (native engine subset).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ValidationEngine } from '../../src/constants.js';
import { validateConformance } from '../../src/services/conformance-validation.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { resolveFlavour } from '../../src/services/pdfa-validator.js';
import { findVeraPdf, resetVeraPdfCache } from '../../src/services/verapdf.js';
import { createSignedPdf, createTestIdentity, type TestIdentity } from '../helpers/signed-pdf.js';

let identity: TestIdentity;

beforeAll(async () => {
  identity = await createTestIdentity();
});

describe('resolveFlavour', () => {
  it('parses explicit flavour strings', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    expect(resolveFlavour(parsed, 'pdfa-1b')).toEqual({ part: 1, conformance: 'B' });
    expect(resolveFlavour(parsed, 'PDFA-3')).toEqual({ part: 3, conformance: null });
    expect(resolveFlavour(parsed, 'bogus')).toBeNull();
  });

  it('reads the XMP declaration', async () => {
    const pdf = await createSignedPdf(identity, { xmp: { pdfaPart: '2', pdfaConformance: 'B' } });
    const parsed = await parsePdfBytes(pdf);
    expect(resolveFlavour(parsed)).toEqual({ part: 2, conformance: 'B' });
  });
});

describe('validateConformance (native engine)', () => {
  it('detects violations in a declared PDF/A document', async () => {
    const pdf = await createSignedPdf(identity, { xmp: { pdfaPart: '2', pdfaConformance: 'B' } });
    const parsed = await parsePdfBytes(pdf);
    const report = await validateConformance(parsed, '', { engine: ValidationEngine.NATIVE });

    expect(report.engine).toBe('native');
    expect(report.flavour).toBe('PDF/A-2b');
    expect(report.compliant).toBe(false);

    const failedIds = report.violations.map((v) => v.ruleId);
    // The minimal fixture has no trailer /ID and no OutputIntent
    expect(failedIds).toContain('file-id');
    expect(failedIds).toContain('output-intent');
    // ...but is not encrypted and uses no LZW
    expect(failedIds).not.toContain('no-encryption');
    expect(failedIds).not.toContain('no-lzw');
  });

  it('flags PDF version against PDF/A-1 (1.7 > 1.4)', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    const report = await validateConformance(parsed, '', {
      engine: ValidationEngine.NATIVE,
      flavour: 'pdfa-1b',
    });

    const failedIds = report.violations.map((v) => v.ruleId);
    expect(failedIds).toContain('pdf-version');
  });

  it('falls back to PDF/A-2b with a note when nothing is declared', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    const report = await validateConformance(parsed, '', { engine: ValidationEngine.NATIVE });

    expect(report.flavour).toBe('PDF/A-2b');
    expect(report.notes.join(' ')).toContain('no PDF/A identification');
  });

  it('rejects an invalid flavour string', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    await expect(
      validateConformance(parsed, '', { engine: ValidationEngine.NATIVE, flavour: 'pdfx-9z' }),
    ).rejects.toThrow(/Invalid flavour/);
  });

  it('points PDF/UA documents to pdf-reader-mcp', async () => {
    const pdf = await createSignedPdf(identity, { xmp: { pdfuaPart: '1' } });
    const parsed = await parsePdfBytes(pdf);
    const report = await validateConformance(parsed, '', { engine: ValidationEngine.NATIVE });

    expect(report.notes.join(' ')).toContain('validate_tagged');
  });
});

describe('veraPDF engine selection', () => {
  it('errors clearly when engine=verapdf but veraPDF is absent', async () => {
    resetVeraPdfCache();
    const available = await findVeraPdf();
    if (available) return; // environment has veraPDF — skip the negative test

    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    await expect(
      validateConformance(parsed, '', { engine: ValidationEngine.VERAPDF }),
    ).rejects.toThrow(/veraPDF not found/);
  });
});
