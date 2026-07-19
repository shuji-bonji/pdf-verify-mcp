/**
 * PDF/UA-shaped fixture builder, shared by the PDF/UA validation tests and
 * the encrypted-document (Issue #7) tests. Extracted from
 * validate-pdfua.test.ts unchanged.
 */

import {
  type PDFArray,
  type PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
} from 'pdf-lib';

export interface UaFixtureOptions {
  marked?: boolean;
  structTree?: boolean;
  lang?: string | null;
  displayDocTitle?: boolean;
  title?: string | null;
  /** Set Info /Title but omit dc:title from XMP (ua-title must still fail) */
  omitXmpTitle?: boolean;
  pdfuaPart?: string | null;
  /** Structure elements: tag name plus optional /Alt */
  elements?: Array<{ tag: string; alt?: string }>;
  /** Add a Link annotation with or without /Contents */
  link?: { contents?: string };
}

export function xmpPacket(part: string | null, title: string | null): string {
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
export async function buildUaPdf(options: UaFixtureOptions = {}): Promise<Uint8Array> {
  const {
    marked = true,
    structTree = true,
    lang = 'ja-JP',
    displayDocTitle = true,
    title = 'Accessible Document',
    omitXmpTitle = false,
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
  const xmpStream = context.stream(xmpPacket(pdfuaPart, omitXmpTitle ? null : title), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  catalog.set(PDFName.of('Metadata'), context.register(xmpStream));

  return doc.save();
}
