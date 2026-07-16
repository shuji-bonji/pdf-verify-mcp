/**
 * PDF/UA (ISO 14289) native validation.
 *
 * Fixtures are built with pdf-lib so the structure tree is under test control:
 * a fully conformant document should produce no violations, and each defect is
 * introduced in isolation to pin the rule that catches it.
 */

import {
  type PDFArray,
  type PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { ValidationEngine } from '../../src/constants.js';
import { validateConformance } from '../../src/services/conformance-validation.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';

interface FixtureOptions {
  marked?: boolean;
  structTree?: boolean;
  lang?: string | null;
  displayDocTitle?: boolean;
  title?: string | null;
  pdfuaPart?: string | null;
  /** Structure elements: tag name plus optional /Alt */
  elements?: Array<{ tag: string; alt?: string }>;
  /** Add a Link annotation with or without /Contents */
  link?: { contents?: string };
}

function xmpPacket(part: string | null, title: string | null): string {
  const ua = part
    ? `<rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" pdfuaid:part="${part}"/>`
    : '';
  const dc = title
    ? `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title></rdf:Description>`
    : '';
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
${ua}
${dc}
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** Build a PDF/UA-shaped document; every defect is opt-in via options. */
async function buildUaPdf(options: FixtureOptions = {}): Promise<Uint8Array> {
  const {
    marked = true,
    structTree = true,
    lang = 'ja-JP',
    displayDocTitle = true,
    title = 'Accessible Document',
    pdfuaPart = '1',
    elements = [{ tag: 'H1' }, { tag: 'P' }],
    link,
  } = options;

  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const { context, catalog } = doc;

  if (title) doc.setTitle(title);

  if (marked) {
    catalog.set(PDFName.of('MarkInfo'), context.obj({ Marked: true }));
  }
  if (lang) {
    catalog.set(PDFName.of('Lang'), PDFString.of(lang));
  }
  catalog.set(PDFName.of('ViewerPreferences'), context.obj({ DisplayDocTitle: displayDocTitle }));

  if (structTree) {
    const rootRef = context.nextRef();
    const kids = context.obj([]) as PDFArray;

    for (const el of elements) {
      const dict = context.obj({}) as PDFDict;
      dict.set(PDFName.of('Type'), PDFName.of('StructElem'));
      dict.set(PDFName.of('S'), PDFName.of(el.tag));
      dict.set(PDFName.of('P'), rootRef);
      dict.set(PDFName.of('Pg'), page.ref);
      if (el.alt !== undefined) dict.set(PDFName.of('Alt'), PDFHexString.fromText(el.alt));
      kids.push(context.register(dict));
    }

    const rootDict = context.obj({}) as PDFDict;
    rootDict.set(PDFName.of('Type'), PDFName.of('StructTreeRoot'));
    rootDict.set(PDFName.of('K'), kids);
    context.assign(rootRef, rootDict);
    catalog.set(PDFName.of('StructTreeRoot'), rootRef);
  }

  if (link) {
    const annot = context.obj({}) as PDFDict;
    annot.set(PDFName.of('Type'), PDFName.of('Annot'));
    annot.set(PDFName.of('Subtype'), PDFName.of('Link'));
    annot.set(PDFName.of('Rect'), context.obj([10, 10, 100, 30]));
    if (link.contents !== undefined) {
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(link.contents));
    }
    page.node.set(PDFName.of('Annots'), context.obj([context.register(annot)]));
  }

  // XMP metadata stream (pdf-lib has no public API for this)
  const xmpStream = context.stream(xmpPacket(pdfuaPart, title), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  catalog.set(PDFName.of('Metadata'), context.register(xmpStream));

  return doc.save();
}

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

  it('flags a mismatch between the declared and requested part', async () => {
    const report = await validate({ pdfuaPart: '2' }, 'pdfua-1');
    const v = report.violations.find((x) => x.ruleId === 'ua-xmp-declaration');
    expect(v?.detail).toMatch(/declares PDF\/UA-2 but validation requested PDF\/UA-1/);
  });
});
