/**
 * PDF/UA (ISO 14289) native validation.
 *
 * Fixtures are built with pdf-lib so the structure tree is under test control:
 * a fully conformant document should produce no violations, and each defect is
 * introduced in isolation to pin the rule that catches it.
 */

import { type PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { ValidationEngine } from '../../src/constants.js';
import { validateConformance } from '../../src/services/conformance-validation.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { validatePdfuaNative } from '../../src/services/pdfua-validator.js';
import { buildUaPdf, type UaFixtureOptions as FixtureOptions } from '../helpers/ua-pdf.js';

async function validate(options: FixtureOptions = {}, flavour = 'pdfua-1') {
  const parsed = await parsePdfBytes(await buildUaPdf(options));
  return validateConformance(parsed, '', { engine: ValidationEngine.NATIVE, flavour });
}

const ruleIds = (report: Awaited<ReturnType<typeof validate>>): string[] =>
  report.violations.map((v) => v.ruleId);

describe('PDF/UA native validation', () => {
  it('reports no violations for a conformant document', async () => {
    const report = await validate();
    expect(report.flavour).toBe('PDF/UA-1');
    expect(report.engine).toBe('native');
    expect(report.violations).toEqual([]);
    // A subset check can never certify conformance
    expect(report.compliant).toBeNull();
    expect(report.notes.join(' ')).toMatch(/SUBSET of ISO 14289/);
  });

  it('catches a missing Marked flag', async () => {
    const report = await validate({ marked: false });
    expect(ruleIds(report)).toContain('ua-marked');
    expect(report.compliant).toBe(false);
  });

  it('catches a missing structure tree', async () => {
    const report = await validate({ structTree: false });
    expect(ruleIds(report)).toContain('ua-struct-tree');
    expect(report.compliant).toBe(false);
  });

  it('catches a missing /Lang', async () => {
    const report = await validate({ lang: null });
    expect(ruleIds(report)).toContain('ua-lang');
  });

  it('catches DisplayDocTitle not being true', async () => {
    const report = await validate({ displayDocTitle: false });
    expect(ruleIds(report)).toContain('ua-display-doc-title');
  });

  it('catches a missing document title', async () => {
    const report = await validate({ title: null });
    expect(ruleIds(report)).toContain('ua-title');
  });

  it('fails ua-title when only Info /Title is set (7.1 requires XMP dc:title)', async () => {
    // Info /Title present, XMP dc:title absent — conforming readers ignore Info
    const report = await validate({ omitXmpTitle: true });
    const v = report.violations.find((x) => x.ruleId === 'ua-title');
    expect(v).toBeDefined();
    expect(v?.detail).toMatch(/Info \/Title is set but XMP has no dc:title/);
  });

  it('catches a missing pdfuaid declaration', async () => {
    const report = await validate({ pdfuaPart: null });
    expect(ruleIds(report)).toContain('ua-xmp-declaration');
  });

  it('catches a Figure without alt text — which reader could not do', async () => {
    const withAlt = await validate({ elements: [{ tag: 'Figure', alt: '棒グラフ: 売上推移' }] });
    expect(ruleIds(withAlt)).not.toContain('ua-figure-alt');

    const without = await validate({ elements: [{ tag: 'Figure' }] });
    expect(ruleIds(without)).toContain('ua-figure-alt');
    expect(without.violations.find((v) => v.ruleId === 'ua-figure-alt')?.detail).toMatch(
      /1 of 1 Figure/,
    );
  });

  it('catches skipped heading levels', async () => {
    const ok = await validate({ elements: [{ tag: 'H1' }, { tag: 'H2' }, { tag: 'H3' }] });
    expect(ruleIds(ok)).not.toContain('ua-heading-hierarchy');

    const skipped = await validate({ elements: [{ tag: 'H1' }, { tag: 'H3' }] });
    expect(ruleIds(skipped)).toContain('ua-heading-hierarchy');
    expect(skipped.violations.find((v) => v.ruleId === 'ua-heading-hierarchy')?.detail).toMatch(
      /H1 followed by H3/,
    );

    const notStartingAtH1 = await validate({ elements: [{ tag: 'H2' }] });
    expect(ruleIds(notStartingAtH1)).toContain('ua-heading-hierarchy');
  });

  it('catches tables without TH/TR', async () => {
    const ok = await validate({
      elements: [{ tag: 'H1' }, { tag: 'Table' }, { tag: 'TR' }, { tag: 'TH' }],
    });
    expect(ruleIds(ok)).not.toContain('ua-table-headers');

    const bad = await validate({ elements: [{ tag: 'H1' }, { tag: 'Table' }] });
    expect(ruleIds(bad)).toContain('ua-table-headers');
  });

  it('catches Link annotations without /Contents', async () => {
    const ok = await validate({ link: { contents: 'GitHub のリポジトリへ' } });
    expect(ruleIds(ok)).not.toContain('ua-link-contents');

    const bad = await validate({ link: {} });
    expect(ruleIds(bad)).toContain('ua-link-contents');
  });

  it('resolves tags through /RoleMap', async () => {
    // A custom tag mapped to H1 must be treated as a heading
    const doc = await PDFDocument.load(await buildUaPdf({ elements: [{ tag: 'MyHeading' }] }));
    const root = doc.catalog.lookup(PDFName.of('StructTreeRoot')) as PDFDict;
    root.set(PDFName.of('RoleMap'), doc.context.obj({ MyHeading: 'H1' }));
    const report = await validateConformance(await parsePdfBytes(await doc.save()), '', {
      engine: ValidationEngine.NATIVE,
      flavour: 'pdfua-1',
    });
    // Mapped to H1, so the hierarchy rule is satisfied
    expect(ruleIds(report)).not.toContain('ua-heading-hierarchy');
  });

  it('separates definitive errors from warnings', async () => {
    const report = await validate();
    const severities = new Set(
      report.violations.map((v) => v.severity).filter((s): s is string => s !== undefined),
    );
    // Nothing failed here, but the rule set must expose severity when it does
    expect(severities.size).toBe(0);

    const withDefect = await validate({ marked: false });
    expect(withDefect.violations.find((v) => v.ruleId === 'ua-marked')?.severity).toBe('error');
  });

  it('rejects an invalid PDF/UA flavour string', async () => {
    const parsed = await parsePdfBytes(await buildUaPdf());
    await expect(
      validateConformance(parsed, '', { engine: ValidationEngine.NATIVE, flavour: 'pdfua-9' }),
    ).rejects.toThrow(/Invalid flavour/);
  });

  it('checks /Encrypt /P bit 10 on encrypted documents (ISO 14289-1, 7.16)', async () => {
    const bytes = await buildUaPdf();
    const parsed = await parsePdfBytes(bytes);

    const check = async (p?: number) => {
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      doc.context.trailerInfo.Encrypt = doc.context.register(
        doc.context.obj(p === undefined ? {} : { P: p }),
      );
      const report = validatePdfuaNative({ ...parsed, isEncrypted: true }, doc, { part: 1 });
      return report.results.find((r) => r.ruleId === 'ua-no-encryption-barrier');
    };

    // All permission bits set (bit 10 included) — passes
    const allowed = await check(-1);
    expect(allowed?.passed).toBe(true);

    // 3904 = 0b1111_0100_0000 has bit 10 (0x200) set, so -3904 clears it
    const denied = await check(-3904);
    expect(denied?.passed).toBe(false);
    expect(denied?.severity).toBe('error');
    expect(denied?.detail).toMatch(/bit 10/);

    // §7.16: an encrypted conforming file SHALL contain a P key
    const noP = await check(undefined);
    expect(noP?.passed).toBe(false);
    expect(noP?.detail).toMatch(/no numeric \/P key/);
  });

  it('flags a mismatch between the declared and requested part', async () => {
    const report = await validate({ pdfuaPart: '2' }, 'pdfua-1');
    const v = report.violations.find((x) => x.ruleId === 'ua-xmp-declaration');
    expect(v?.detail).toMatch(/declares PDF\/UA-2 but validation requested PDF\/UA-1/);
  });
});
