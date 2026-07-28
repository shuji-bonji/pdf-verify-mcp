/**
 * v0.3: PDF/A conformance validation (native engine subset).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ValidationEngine, VERAPDF_ENV } from '../../src/constants.js';
import { validateConformance, veraFlavourId } from '../../src/services/conformance-validation.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { resolveFlavour } from '../../src/services/pdfa-validator.js';
import { findVeraPdf, resetVeraPdfCache, resolveVeraPdf } from '../../src/services/verapdf.js';
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

  // M-9: PDF/A-4 takes no A/B/U level; E and F are variants, not levels.
  it('parses the PDF/A-4 flavours', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    expect(resolveFlavour(parsed, 'pdfa-4')).toEqual({ part: 4, conformance: null });
    expect(resolveFlavour(parsed, 'pdfa-4e')).toEqual({ part: 4, conformance: 'E' });
    expect(resolveFlavour(parsed, 'PDFA-4F')).toEqual({ part: 4, conformance: 'F' });
  });

  it('rejects level/variant combinations that name no real flavour', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    expect(resolveFlavour(parsed, 'pdfa-4b')).toBeNull();
    expect(resolveFlavour(parsed, 'pdfa-4a')).toBeNull();
    expect(resolveFlavour(parsed, 'pdfa-2e')).toBeNull();
    expect(resolveFlavour(parsed, 'pdfa-3f')).toBeNull();
    expect(resolveFlavour(parsed, 'pdfa-5')).toBeNull();
  });

  it('reads a PDF/A-4f declaration, and drops a variant that does not fit the part', async () => {
    const f = await createSignedPdf(identity, { xmp: { pdfaPart: '4', pdfaConformance: 'F' } });
    expect(resolveFlavour(await parsePdfBytes(f))).toEqual({ part: 4, conformance: 'F' });

    const plain4 = await createSignedPdf(identity, { xmp: { pdfaPart: '4' } });
    expect(resolveFlavour(await parsePdfBytes(plain4))).toEqual({ part: 4, conformance: null });

    // A declaration pairing part 4 with a level, or part 2 with a variant, is
    // not a flavour anyone can validate — the stray token is dropped.
    const bogus4 = await createSignedPdf(identity, {
      xmp: { pdfaPart: '4', pdfaConformance: 'B' },
    });
    expect(resolveFlavour(await parsePdfBytes(bogus4))).toEqual({ part: 4, conformance: null });

    const bogus2 = await createSignedPdf(identity, {
      xmp: { pdfaPart: '2', pdfaConformance: 'F' },
    });
    expect(resolveFlavour(await parsePdfBytes(bogus2))).toEqual({ part: 2, conformance: null });
  });
});

describe('veraFlavourId', () => {
  it('maps parts 1-3 to level ids and defaults an absent level to b', () => {
    expect(veraFlavourId({ part: 1, conformance: 'B' })).toBe('1b');
    expect(veraFlavourId({ part: 2, conformance: 'U' })).toBe('2u');
    expect(veraFlavourId({ part: 3, conformance: null })).toBe('3b');
  });

  it('never produces "4b" — PDF/A-4 profile ids are 4, 4e and 4f', () => {
    expect(veraFlavourId({ part: 4, conformance: null })).toBe('4');
    expect(veraFlavourId({ part: 4, conformance: 'E' })).toBe('4e');
    expect(veraFlavourId({ part: 4, conformance: 'F' })).toBe('4f');
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

  it('flags PDF version against PDF/A-4 (1.7 is not 2.0)', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    const report = await validateConformance(parsed, '', {
      engine: ValidationEngine.NATIVE,
      flavour: 'pdfa-4f',
    });

    expect(report.flavour).toBe('PDF/A-4f');
    const failedIds = report.violations.map((v) => v.ruleId);
    expect(failedIds).toContain('pdf-version');
    // The OutputIntent requirement is a -1..-3 rule; whether -4 needs one is a
    // question for veraPDF, so the native engine must not decide it.
    expect(failedIds).not.toContain('output-intent');
    expect(report.notes.join(' ')).toContain('ISO 19005-4');
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

  it('auto-selects PDF/UA when the document declares only PDF/UA', async () => {
    // v0.6: PDF/UA is validated here rather than deferred to pdf-reader-mcp
    const pdf = await createSignedPdf(identity, { xmp: { pdfuaPart: '1' } });
    const parsed = await parsePdfBytes(pdf);
    const report = await validateConformance(parsed, '', { engine: ValidationEngine.NATIVE });

    expect(report.flavour).toBe('PDF/UA-1');
    expect(report.notes.join(' ')).not.toContain('validate_tagged');
  });

  it('prefers PDF/A and mentions PDF/UA when both are declared', async () => {
    const pdf = await createSignedPdf(identity, {
      xmp: { pdfaPart: '2', pdfaConformance: 'B', pdfuaPart: '1' },
    });
    const parsed = await parsePdfBytes(pdf);
    const report = await validateConformance(parsed, '', { engine: ValidationEngine.NATIVE });

    expect(report.flavour).toBe('PDF/A-2b');
    expect(report.notes.join(' ')).toContain('pdfua-1');
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

/**
 * V-A3: a configured-but-unusable PDF_VERIFY_VERAPDF.
 *
 * The env var used to be trusted without checking that it points at something
 * executable, so a stale path was accepted as "found" and only blew up later
 * inside execFile — the caller saw "veraPDF execution failed" and no report at
 * all, where the honest answer is "the validator you configured is not there,
 * and nothing authoritative was run".
 *
 * These tests set the env var themselves, so they exercise the path regardless
 * of whether the machine running them has veraPDF installed. That matters: the
 * neighbouring negative test above returns early on a machine that has it, and
 * a test that quietly skips is a test that cannot fail.
 */
describe('veraPDF configured but unusable', () => {
  const UNUSABLE = '/nonexistent/verapdf';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[VERAPDF_ENV];
    process.env[VERAPDF_ENV] = UNUSABLE;
    resetVeraPdfCache();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[VERAPDF_ENV];
    else process.env[VERAPDF_ENV] = saved;
    resetVeraPdfCache();
  });

  it('reports the path as unusable instead of treating it as found', async () => {
    const availability = await resolveVeraPdf();
    expect(availability.available).toBe(false);
    expect(availability).toMatchObject({
      reason: 'configured_path_unusable',
      configuredPath: UNUSABLE,
    });
  });

  it('does not substitute another executable for the configured one', async () => {
    // Even on a machine with veraPDF on PATH, an explicit setting that is wrong
    // must surface — a verdict from a validator nobody chose is worse than none.
    expect(await findVeraPdf()).toBeNull();
  });

  it('falls back to native and says the authoritative validation was not performed', async () => {
    const pdf = await createSignedPdf(identity, { xmp: { pdfaPart: '2', pdfaConformance: 'B' } });
    const parsed = await parsePdfBytes(pdf);
    const report = await validateConformance(parsed, '', { engine: ValidationEngine.AUTO });

    expect(report.engine).toBe('native');
    expect(report.authoritativeValidation).toMatchObject({
      performed: false,
      validator: 'verapdf',
      reason: 'configured_path_unusable',
    });
    // The reason has to reach the prose too: Skills read notes, not types.
    const notes = report.notes.join(' ');
    expect(notes).toContain(UNUSABLE);
    expect(notes).toMatch(/NOT performed/i);
    expect(notes).toMatch(/cannot certify/i);
  });

  it('errors with VERAPDF_NOT_AVAILABLE when engine=verapdf was demanded', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    await expect(
      validateConformance(parsed, '', { engine: ValidationEngine.VERAPDF }),
    ).rejects.toMatchObject({ code: 'VERAPDF_NOT_AVAILABLE' });
  });

  it('carries the non-execution into the PDF/UA path as well', async () => {
    const pdf = await createSignedPdf(identity, { xmp: { pdfuaPart: '1' } });
    const parsed = await parsePdfBytes(pdf);
    const report = await validateConformance(parsed, '', { flavour: 'pdfua-1' });

    expect(report.engine).toBe('native');
    expect(report.authoritativeValidation.performed).toBe(false);
    expect(report.notes.join(' ')).toMatch(/NOT performed/i);
  });
});

describe('authoritative validation provenance', () => {
  const savedEnv = process.env[VERAPDF_ENV];

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[VERAPDF_ENV];
    else process.env[VERAPDF_ENV] = savedEnv;
    resetVeraPdfCache();
  });

  it('accepts an executable env path and records where it came from', async () => {
    // /bin/sh stands in for veraPDF: the point is that an *executable* env path
    // is accepted, which is what distinguishes this from the unusable case.
    process.env[VERAPDF_ENV] = '/bin/sh';
    resetVeraPdfCache();
    expect(await resolveVeraPdf()).toEqual({
      available: true,
      path: '/bin/sh',
      source: 'env',
    });
  });

  it('names engine=native as the reason rather than implying veraPDF is missing', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    const report = await validateConformance(parsed, '', { engine: ValidationEngine.NATIVE });

    expect(report.authoritativeValidation).toMatchObject({
      performed: false,
      reason: 'native_engine_requested',
    });
  });
});
