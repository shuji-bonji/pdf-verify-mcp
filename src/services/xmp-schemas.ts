/**
 * XMP namespaces and PDF/A extension schemas (#23).
 *
 * ISO 19005 lets an XMP packet carry only properties whose schema is either predefined
 * (the XMP Specification's schemas, plus the ones ISO 19005 itself defines) or described in
 * the packet by a PDF/A extension schema (`pdfaExtension:schemas`; ISO 19005-1 6.7.8,
 * ISO 19005-2/-3 6.6.2.3, ISO 19005-4 6.6.2.3). veraPDF reports the breach as
 * `6.6.2.3.1 test1` ("XMP property is either not predefined, or is not defined in any
 * XMP extension schema") and names the property's namespace URI in the check context.
 *
 * This module answers two observational questions from the packet text alone:
 *   - which namespaces does it use, and is each predefined / described / neither;
 *   - what is a namespace, in words, when it is one this family knows about.
 * It does not decide conformance — that is veraPDF's job and the native rule subset
 * deliberately does not walk the whole packet (CLAUDE.md, pitfall 3).
 */

/**
 * Namespace URIs ISO 19005 treats as predefined. The XMP Specification Part 1 schemas
 * (2005 edition is what PDF/A-1 names; later parts name the 2008/2012 editions, same URIs),
 * plus pdfaid and the extension-schema container schemas themselves, plus RDF/XML and
 * the `x:xmpmeta` wrapper. A namespace missing here is not thereby forbidden — it needs
 * a description in `pdfaExtension:schemas`.
 */
export const PREDEFINED_XMP_NAMESPACES: ReadonlySet<string> = new Set([
  // XMP Specification Part 1 / Part 2
  'http://purl.org/dc/elements/1.1/', // dc
  'http://ns.adobe.com/xap/1.0/', // xmp
  'http://ns.adobe.com/xap/1.0/rights/', // xmpRights
  'http://ns.adobe.com/xap/1.0/mm/', // xmpMM
  'http://ns.adobe.com/xap/1.0/bj/', // xmpBJ
  'http://ns.adobe.com/xap/1.0/t/pg/', // xmpTPg
  'http://ns.adobe.com/xmp/1.0/DynamicMedia/', // xmpDM
  'http://ns.adobe.com/pdf/1.3/', // pdf
  'http://ns.adobe.com/photoshop/1.0/', // photoshop
  'http://ns.adobe.com/camera-raw-settings/1.0/', // crs
  'http://ns.adobe.com/tiff/1.0/', // tiff
  'http://ns.adobe.com/exif/1.0/', // exif
  'http://ns.adobe.com/exif/1.0/aux/', // aux
  // value-type schemas
  'http://ns.adobe.com/xap/1.0/sType/ResourceEvent#', // stEvt
  'http://ns.adobe.com/xap/1.0/sType/ResourceRef#', // stRef
  'http://ns.adobe.com/xap/1.0/sType/Version#', // stVer
  'http://ns.adobe.com/xap/1.0/sType/Job#', // stJob
  'http://ns.adobe.com/xap/1.0/sType/Dimensions#', // stDim
  'http://ns.adobe.com/xap/1.0/sType/Font#', // stFnt
  'http://ns.adobe.com/xap/1.0/g/', // xapG (colorant)
  'http://ns.adobe.com/xap/1.0/g/img/', // xapGImg (thumbnail)
  // ISO 19005
  'http://www.aiim.org/pdfa/ns/id/', // pdfaid
  'http://www.aiim.org/pdfa/ns/extension/', // pdfaExtension
  'http://www.aiim.org/pdfa/ns/schema#', // pdfaSchema
  'http://www.aiim.org/pdfa/ns/property#', // pdfaProperty
  'http://www.aiim.org/pdfa/ns/type#', // pdfaType
  'http://www.aiim.org/pdfa/ns/field#', // pdfaField
  // containers, not property schemas
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#', // rdf
  'adobe:ns:meta/', // x
]);

/** What a namespace is, when this family can say. The TDMRep spellings are both the W3C report's own. */
const KNOWN_NAMESPACES: ReadonlyArray<{ uris: string[]; name: string; note: string }> = [
  {
    uris: ['http://www.w3.org/ns/tdmrep/', 'http://www.w3.org/ns/tdmrep#'],
    name: 'W3C TDM Reservation Protocol (TDMRep)',
    note:
      "the rights holder's text-and-data-mining statement (tdm:reservation / tdm:policy). " +
      'TDMRep and PDF/A can coexist: PDF/A requires the packet to describe this schema in ' +
      'pdfaExtension:schemas (reservation as Integer, policy as URL). The W3C report (2024-05-10, §6.6) ' +
      'notes that PDF/A validators raise errors otherwise; this is why.',
  },
  {
    uris: ['http://www.aiim.org/pdfua/ns/id/'],
    name: 'PDF/UA identification (pdfuaid)',
    note: 'not predefined by ISO 19005 either; a PDF/A document declaring PDF/UA must describe it in pdfaExtension:schemas.',
  },
];

export interface XmpNamespaceInfo {
  prefix: string;
  uri: string;
  /** Predefined by the XMP Specification or ISO 19005 — needs no extension schema. */
  predefined: boolean;
  /** A `pdfaSchema:namespaceURI` in the packet's `pdfaExtension:schemas` names this URI. */
  describedByExtensionSchema: boolean;
  /** What this family knows the namespace to be, when it does. */
  known: string | null;
}

/** Every `xmlns:` declaration in the packet, in order of first appearance. */
export function collectXmpNamespaces(xmp: string): { prefix: string; uri: string }[] {
  const seen = new Map<string, string>();
  for (const m of xmp.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=\s*["']([^"']+)["']/g)) {
    if (!seen.has(m[1])) seen.set(m[1], m[2]);
  }
  return [...seen].map(([prefix, uri]) => ({ prefix, uri }));
}

/** The namespace URIs described by `pdfaSchema:namespaceURI` entries (attribute or element form). */
export function collectExtensionSchemaUris(xmp: string): string[] {
  const uris = new Set<string>();
  for (const m of xmp.matchAll(
    /<pdfaSchema:namespaceURI(?:\s[^>]*)?>\s*([^<\s]+)\s*<\/pdfaSchema:namespaceURI>/g,
  )) {
    uris.add(m[1]);
  }
  for (const m of xmp.matchAll(/\spdfaSchema:namespaceURI\s*=\s*["']([^"']+)["']/g)) {
    uris.add(m[1]);
  }
  return [...uris];
}

export function describeKnownNamespace(uri: string): { name: string; note: string } | null {
  const hit = KNOWN_NAMESPACES.find((k) => k.uris.includes(uri));
  return hit ? { name: hit.name, note: hit.note } : null;
}

/** Namespaces in use, each classified. An observation; the verdict stays with the validator. */
export function analyzeXmpNamespaces(xmp: string): XmpNamespaceInfo[] {
  const described = new Set(collectExtensionSchemaUris(xmp));
  return collectXmpNamespaces(xmp).map(({ prefix, uri }) => ({
    prefix,
    uri,
    predefined: PREDEFINED_XMP_NAMESPACES.has(uri),
    describedByExtensionSchema: described.has(uri),
    known: describeKnownNamespace(uri)?.name ?? null,
  }));
}

/**
 * Parse the property named in a veraPDF check context for the extension-schema rules, e.g.
 * `root/document[0]/metadata[0](19 0 obj PDMetadata)/XMPPackage[0]/Properties[4](http://www.w3.org/ns/tdmrep/ - tdm:reservation)`.
 * Returns null for a context of another shape.
 */
export function parseVeraPdfXmpPropertyContext(
  context: string,
): { namespace: string; property: string } | null {
  const m = /Properties\[\d+\]\(([^\s)]+)\s+-\s+([^\s)]+)\)/.exec(context);
  return m ? { namespace: m[1], property: m[2] } : null;
}

/** veraPDF clauses that are the "property must be predefined or described" requirement, by part. */
export function isXmpSchemaClause(clause: string): boolean {
  // PDF/A-1: 6.7.8 (and 6.7.9 for the extension schema's own form); PDF/A-2, -3, -4: 6.6.2.3.x
  return /^6\.7\.8\b|^6\.7\.9\b|^6\.6\.2\.3\b/.test(clause);
}

/**
 * One sentence naming the namespaces behind an extension-schema violation, for the
 * violation's `detail`. Groups properties by namespace; names the namespace when known.
 */
export function explainXmpSchemaViolation(
  properties: { namespace: string; property: string }[],
): string | null {
  if (properties.length === 0) return null;
  const byNs = new Map<string, string[]>();
  for (const p of properties) {
    const list = byNs.get(p.namespace) ?? [];
    if (!list.includes(p.property)) list.push(p.property);
    byNs.set(p.namespace, list);
  }
  const parts: string[] = [];
  for (const [ns, props] of byNs) {
    const known = describeKnownNamespace(ns);
    parts.push(
      `${ns} (${props.join(', ')})${known ? ` — ${known.name}: ${known.note}` : ' — not predefined by ISO 19005 and not described in pdfaExtension:schemas'}`,
    );
  }
  return `Properties whose schema is neither predefined nor described in the packet: ${parts.join('; ')}`;
}
