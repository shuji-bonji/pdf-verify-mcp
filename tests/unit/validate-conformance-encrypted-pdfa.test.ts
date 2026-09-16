/**
 * stack #38: PDF/A + veraPDF on an encrypted file must not surface as INTERNAL_ERROR.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ValidationEngine, VERAPDF_ENV } from '../../src/constants.js';
import { validateConformance } from '../../src/services/conformance-validation.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { resetVeraPdfCache } from '../../src/services/verapdf.js';
import { createSignedPdf, createTestIdentity, type TestIdentity } from '../helpers/signed-pdf.js';

let identity: TestIdentity;

beforeAll(async () => {
  identity = await createTestIdentity();
});

describe('PDF/A validate_conformance on an encrypted document (stack #38)', () => {
  const savedEnv = process.env[VERAPDF_ENV];

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[VERAPDF_ENV];
    else process.env[VERAPDF_ENV] = savedEnv;
    resetVeraPdfCache();
  });

  it('returns ENCRYPTED_PDF when veraPDF would be consulted, not INTERNAL_ERROR', async () => {
    // /bin/sh is executable, so resolveVeraPdf treats it as present. The point
    // is that we refuse before execFile — an encrypted file must not reach veraPDF.
    process.env[VERAPDF_ENV] = '/bin/sh';
    resetVeraPdfCache();

    const parsed = await parsePdfBytes(await createSignedPdf(identity));
    parsed.isEncrypted = true;

    await expect(
      validateConformance(parsed, '/tmp/encrypted-for-pdfa.pdf', {
        flavour: 'pdfa-3b',
        engine: ValidationEngine.AUTO,
      }),
    ).rejects.toMatchObject({ code: 'ENCRYPTED_PDF' });
  });

  it('native engine still reports no-encryption instead of throwing', async () => {
    const parsed = await parsePdfBytes(await createSignedPdf(identity));
    parsed.isEncrypted = true;

    const report = await validateConformance(parsed, '', {
      flavour: 'pdfa-3b',
      engine: ValidationEngine.NATIVE,
    });

    expect(report.engine).toBe('native');
    expect(report.violations.map((v) => v.ruleId)).toContain('no-encryption');
    expect(report.compliant).toBe(false);
  });
});
