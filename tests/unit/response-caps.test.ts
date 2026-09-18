/**
 * v0.29.0 (#18): JSON responses are bounded by per-array caps, never by a
 * character limit; markdown keeps the character limit.
 */

import { describe, expect, it } from 'vitest';
import { CHARACTER_LIMIT, MAX_SIGNATURES } from '../../src/constants.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { detectPadesLevels, verifySignatures } from '../../src/services/verification-service.js';
import { renderBody, truncateIfNeeded } from '../../src/utils/formatter.js';
import { capArray } from '../../src/utils/truncation.js';
import {
  appendObjectRevision,
  createSignedPdf,
  createTestIdentity,
} from '../helpers/signed-pdf.js';

/** One real signature followed by `extra` stub signature fields (unsigned, empty /Contents) */
async function pdfWithManyFields(extra: number): Promise<Uint8Array> {
  const signed = await createSignedPdf(await createTestIdentity());
  // ByteRange end far beyond the file so the stubs sort after the real signature
  const objects = Array.from({ length: extra }, (_, i) => ({
    objectNumber: 100 + i,
    body: `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 0 ${9_000_000 + i} 0] /Contents <> >>`,
  }));
  return appendObjectRevision(signed, { objects });
}

describe('capArray', () => {
  it('reports the cut only when something was cut', () => {
    expect(capArray([1, 2, 3], 3)).toEqual({ items: [1, 2, 3], truncated: null });
    expect(capArray([1, 2, 3], 2)).toEqual({ items: [1, 2], truncated: { returned: 2, total: 3 } });
  });
});

describe('verify_signatures cap', () => {
  it('verifies only the first MAX_SIGNATURES fields when asked', async () => {
    const parsed = await parsePdfBytes(await pdfWithManyFields(MAX_SIGNATURES + 5));
    expect(parsed.signatures.length).toBe(MAX_SIGNATURES + 6);
    const capped = await verifySignatures(parsed, { maxSignatures: MAX_SIGNATURES });
    expect(capped.length).toBe(MAX_SIGNATURES);
    expect(capped[0].verdict).toBe('valid');
    const all = await verifySignatures(parsed);
    expect(all.length).toBe(MAX_SIGNATURES + 6);
  });

  it('detect_pades_level lists are capped by the tool, not the service', async () => {
    const parsed = await parsePdfBytes(await pdfWithManyFields(MAX_SIGNATURES + 5));
    const levels = await detectPadesLevels(parsed);
    expect(levels.length).toBe(MAX_SIGNATURES + 6);
    expect(capArray(levels, MAX_SIGNATURES).truncated).toEqual({
      returned: MAX_SIGNATURES,
      total: MAX_SIGNATURES + 6,
    });
  });
});

describe('renderBody', () => {
  const big = { items: 'x'.repeat(CHARACTER_LIMIT + 100) };

  it('never cuts JSON', () => {
    const text = renderBody(true, big, () => 'unused');
    expect(text.length).toBeGreaterThan(CHARACTER_LIMIT);
    expect(JSON.parse(text)).toEqual(big);
  });

  it('cuts markdown at CHARACTER_LIMIT and says so', () => {
    const text = renderBody(false, big, () => 'm'.repeat(CHARACTER_LIMIT + 100));
    expect(text.length).toBeLessThan(CHARACTER_LIMIT + 200);
    expect(text).toContain('(truncated');
    expect(truncateIfNeeded('short').truncated).toBe(false);
  });
});
