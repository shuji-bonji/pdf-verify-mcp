/**
 * Native PDF/A validation rule engine (v0.3).
 *
 * Implements a pragmatic SUBSET of ISO 19005 requirements — the rules that
 * catch the most common real-world violations. This is NOT a veraPDF
 * replacement: a document passing all native rules is "no violations
 * detected within the checked rule set", not "certified conformant".
 * When veraPDF is available it should be preferred (see verapdf.ts).
 */

import { PDFArray, PDFBool, PDFDict, type PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import type { ParsedPdf } from '../types.js';

/** PDF/A flavour under validation */
export interface PdfaFlavour {
  /** 1 | 2 | 3 */
  part: number;
  /** 'A' | 'B' | 'U' | null (unknown) */
  conformance: string | null;
}

export interface RuleResult {
  ruleId: string;
  /** ISO 19005 clause reference */
  clause: string;
  description: string;
  passed: boolean;
  /** Human-readable evidence when failed */
  detail: string | null;
}

export interface NativeValidationReport {
  flavour: PdfaFlavour;
  /** false when any rule failed; true = no violations IN THE CHECKED SUBSET */
  allCheckedRulesPassed: boolean;
  results: RuleResult[];
  notes: string[];
}

interface RuleContext {
  parsed: ParsedPdf;
  doc: PDFDocument;
  flavour: PdfaFlavour;
}

interface Rule {
  ruleId: string;
  clause: string;
  description: string;
  /** Restrict to certain parts (e.g. transparency ban is PDF/A-1 only) */
  appliesToParts?: number[];
  check: (ctx: RuleContext) => { passed: boolean; detail: string | null };
}

function enumerateDicts(doc: PDFDocument): PDFDict[] {
  const dicts: PDFDict[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) dicts.push(object);
  }
  return dicts;
}

/** Collect names used in /Filter entries across all streams */
function collectFilterNames(doc: PDFDocument): Set<string> {
  const filters = new Set<string>();
  for (const dict of enumerateDicts(doc)) {
    const filter = dict.get(PDFName.of('Filter'));
    if (filter instanceof PDFName) filters.add(filter.decodeText());
    if (filter instanceof PDFArray) {
      for (let i = 0; i < filter.size(); i++) {
        const item = filter.get(i);
        if (item instanceof PDFName) filters.add(item.decodeText());
      }
    }
  }
  return filters;
}

const STANDARD_14 = new Set([
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Symbol',
  'ZapfDingbats',
]);

/** Check that every font has an embedded font program */
function checkFontsEmbedded(ctx: RuleContext): { passed: boolean; detail: string | null } {
  const missing: string[] = [];
  for (const dict of enumerateDicts(ctx.doc)) {
    const type = dict.get(PDFName.of('Type'));
    if (!(type instanceof PDFName) || type.decodeText() !== 'Font') continue;
    const subtype = dict.get(PDFName.of('Subtype'));
    const subtypeName = subtype instanceof PDFName ? subtype.decodeText() : '';
    // Type0 composite fonts delegate to descendant fonts (checked separately);
    // Type3 fonts have glyph procedures instead of font programs.
    if (subtypeName === 'Type0' || subtypeName === 'Type3') continue;

    const descriptorRef = dict.get(PDFName.of('FontDescriptor'));
    const descriptor =
      descriptorRef instanceof PDFRef ? ctx.doc.context.lookup(descriptorRef) : descriptorRef;
    const baseFont = dict.get(PDFName.of('BaseFont'));
    const baseFontName = baseFont instanceof PDFName ? baseFont.decodeText() : '(unknown)';

    if (!(descriptor instanceof PDFDict)) {
      missing.push(
        `${baseFontName} (no FontDescriptor${STANDARD_14.has(baseFontName) ? '; standard-14 fonts must be embedded in PDF/A' : ''})`,
      );
      continue;
    }
    const hasProgram =
      descriptor.has(PDFName.of('FontFile')) ||
      descriptor.has(PDFName.of('FontFile2')) ||
      descriptor.has(PDFName.of('FontFile3'));
    if (!hasProgram) missing.push(baseFontName);
  }
  return {
    passed: missing.length === 0,
    detail:
      missing.length > 0
        ? `Fonts without embedded program: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` (+${missing.length - 10} more)` : ''}`
        : null,
  };
}

/** Search all dicts for any of the given keys */
function findDictsWithKey(doc: PDFDocument, keys: string[]): number {
  let count = 0;
  for (const dict of enumerateDicts(doc)) {
    for (const key of keys) {
      if (dict.has(PDFName.of(key))) {
        count++;
        break;
      }
    }
  }
  return count;
}

/** Search for action dictionaries with prohibited /S values */
function findProhibitedActions(doc: PDFDocument, actions: string[]): string[] {
  const found = new Set<string>();
  for (const dict of enumerateDicts(doc)) {
    const s = dict.get(PDFName.of('S'));
    if (s instanceof PDFName && actions.includes(s.decodeText())) {
      found.add(s.decodeText());
    }
  }
  return [...found];
}

const RULES: Rule[] = [
  {
    ruleId: 'no-encryption',
    clause: 'ISO 19005-1, 6.1.3',
    description: 'The trailer dictionary shall not contain an Encrypt entry',
    check: (ctx) => ({
      passed: !ctx.parsed.isEncrypted,
      detail: ctx.parsed.isEncrypted ? 'Document is encrypted (/Encrypt present)' : null,
    }),
  },
  {
    ruleId: 'file-id',
    clause: 'ISO 19005-1, 6.1.3',
    description: 'The trailer dictionary shall contain an ID entry',
    check: (ctx) => {
      const id = ctx.doc.context.trailerInfo.ID;
      return {
        passed: Boolean(id),
        detail: id ? null : 'Trailer /ID is missing',
      };
    },
  },
  {
    ruleId: 'no-lzw',
    clause: 'ISO 19005-1, 6.1.10',
    description: 'The LZWDecode filter shall not be used',
    check: (ctx) => {
      const filters = collectFilterNames(ctx.doc);
      const used = filters.has('LZWDecode');
      return { passed: !used, detail: used ? 'LZWDecode filter in use' : null };
    },
  },
  {
    ruleId: 'no-crypt-filter',
    clause: 'ISO 19005-2, 6.1.7',
    description: 'The Crypt filter shall not be used',
    check: (ctx) => {
      const filters = collectFilterNames(ctx.doc);
      const used = filters.has('Crypt');
      return { passed: !used, detail: used ? 'Crypt filter in use' : null };
    },
  },
  {
    ruleId: 'pdf-version',
    clause: 'ISO 19005-1, 6.1.2 / 19005-2, 6.1.2',
    description: 'PDF version shall be within the allowed range (A-1: ≤1.4, A-2/A-3: ≤1.7)',
    check: (ctx) => {
      const version = Number.parseFloat(ctx.parsed.pdfVersion ?? '0');
      const limit = ctx.flavour.part === 1 ? 1.4 : 1.7;
      const ok = version > 0 && version <= limit;
      return {
        passed: ok,
        detail: ok
          ? null
          : `Header version ${ctx.parsed.pdfVersion} exceeds PDF/A-${ctx.flavour.part} limit (${limit})`,
      };
    },
  },
  {
    ruleId: 'xmp-declaration',
    clause: 'ISO 19005-1, 6.7.11',
    description: 'XMP metadata shall declare the PDF/A identification (pdfaid)',
    check: (ctx) => {
      const declared = ctx.parsed.xmpMetadata?.includes('pdfaid:part') ?? false;
      return {
        passed: declared,
        detail: declared ? null : 'No pdfaid:part declaration in XMP metadata',
      };
    },
  },
  {
    ruleId: 'output-intent',
    clause: 'ISO 19005-1, 6.2.2',
    description: 'A PDF/A OutputIntent (GTS_PDFA1) shall be present',
    check: (ctx) => {
      const intents = ctx.doc.catalog.lookup(PDFName.of('OutputIntents'));
      if (intents instanceof PDFArray) {
        for (let i = 0; i < intents.size(); i++) {
          const intent = intents.lookup(i);
          if (intent instanceof PDFDict) {
            const s = intent.get(PDFName.of('S'));
            if (s instanceof PDFName && s.decodeText() === 'GTS_PDFA1') {
              return { passed: true, detail: null };
            }
          }
        }
      }
      return { passed: false, detail: 'No OutputIntent with subtype GTS_PDFA1' };
    },
  },
  {
    ruleId: 'fonts-embedded',
    clause: 'ISO 19005-1, 6.3.4',
    description: 'All fonts shall be embedded',
    check: checkFontsEmbedded,
  },
  {
    ruleId: 'no-javascript',
    clause: 'ISO 19005-1, 6.6.1',
    description: 'JavaScript actions shall not be used',
    check: (ctx) => {
      const count = findDictsWithKey(ctx.doc, ['JS', 'JavaScript']);
      return {
        passed: count === 0,
        detail: count > 0 ? `${count} dictionary(ies) with /JS or /JavaScript` : null,
      };
    },
  },
  {
    ruleId: 'no-prohibited-actions',
    clause: 'ISO 19005-1, 6.6.1',
    description: 'Launch, Sound, Movie, ImportData and ResetForm actions shall not be used',
    check: (ctx) => {
      const found = findProhibitedActions(ctx.doc, [
        'Launch',
        'Sound',
        'Movie',
        'ImportData',
        'ResetForm',
      ]);
      return {
        passed: found.length === 0,
        detail: found.length > 0 ? `Prohibited action type(s): ${found.join(', ')}` : null,
      };
    },
  },
  {
    ruleId: 'no-embedded-files',
    clause: 'ISO 19005-1, 6.1.11',
    description: 'Embedded files shall not be present (PDF/A-1; A-2 restricts, A-3 allows)',
    appliesToParts: [1],
    check: (ctx) => {
      const count = findDictsWithKey(ctx.doc, ['EF']);
      const names = ctx.doc.catalog.lookup(PDFName.of('Names'));
      const hasEfTree = names instanceof PDFDict && names.has(PDFName.of('EmbeddedFiles'));
      const violated = count > 0 || hasEfTree;
      return {
        passed: !violated,
        detail: violated
          ? 'Embedded file specification (/EF or EmbeddedFiles name tree) present'
          : null,
      };
    },
  },
  {
    ruleId: 'no-transparency',
    clause: 'ISO 19005-1, 6.4',
    description: 'Transparency shall not be used (PDF/A-1 only)',
    appliesToParts: [1],
    check: (ctx) => {
      let violations = 0;
      for (const dict of enumerateDicts(ctx.doc)) {
        const smask = dict.get(PDFName.of('SMask'));
        if (smask && !(smask instanceof PDFName && smask.decodeText() === 'None')) {
          violations++;
        }
      }
      return {
        passed: violations === 0,
        detail: violations > 0 ? `${violations} object(s) with a non-None /SMask` : null,
      };
    },
  },
  {
    ruleId: 'no-xfa',
    clause: 'ISO 19005-2, 6.6.2',
    description: 'XFA forms shall not be present',
    check: (ctx) => {
      const acroForm = ctx.doc.catalog.lookup(PDFName.of('AcroForm'));
      const hasXfa = acroForm instanceof PDFDict && acroForm.has(PDFName.of('XFA'));
      return { passed: !hasXfa, detail: hasXfa ? 'AcroForm contains /XFA' : null };
    },
  },
  {
    ruleId: 'no-need-appearances',
    clause: 'ISO 19005-1, 6.9',
    description: 'AcroForm NeedAppearances shall be false or absent',
    check: (ctx) => {
      const acroForm = ctx.doc.catalog.lookup(PDFName.of('AcroForm'));
      if (acroForm instanceof PDFDict) {
        const na = acroForm.lookup(PDFName.of('NeedAppearances'));
        if (na instanceof PDFBool && na.asBoolean()) {
          return { passed: false, detail: 'AcroForm /NeedAppearances is true' };
        }
      }
      return { passed: true, detail: null };
    },
  },
  {
    ruleId: 'no-aa-catalog',
    clause: 'ISO 19005-1, 6.6.2',
    description: 'The document catalog shall not contain an AA (additional actions) entry',
    check: (ctx) => {
      const hasAa = ctx.doc.catalog.has(PDFName.of('AA'));
      return { passed: !hasAa, detail: hasAa ? 'Catalog contains /AA' : null };
    },
  },
];

/** Determine the flavour to validate: explicit request or the XMP declaration */
export function resolveFlavour(parsed: ParsedPdf, requested?: string): PdfaFlavour | null {
  if (requested) {
    const match = /^pdfa-([123])([abu])?$/i.exec(requested);
    if (match) {
      return { part: Number(match[1]), conformance: match[2]?.toUpperCase() ?? null };
    }
    return null;
  }
  const xmp = parsed.xmpMetadata;
  if (!xmp) return null;
  const part =
    /pdfaid:part\s*=\s*["'](\d+)["']/.exec(xmp) ??
    /<pdfaid:part>\s*(\d+)\s*<\/pdfaid:part>/.exec(xmp);
  if (!part) return null;
  const conf =
    /pdfaid:conformance\s*=\s*["']([A-Ua-u])["']/.exec(xmp) ??
    /<pdfaid:conformance>\s*([A-Ua-u])\s*<\/pdfaid:conformance>/.exec(xmp);
  return { part: Number(part[1]), conformance: conf ? conf[1].toUpperCase() : null };
}

/** Run the native rule subset against a parsed document */
export function validatePdfaNative(
  parsed: ParsedPdf,
  doc: PDFDocument,
  flavour: PdfaFlavour,
): NativeValidationReport {
  const ctx: RuleContext = { parsed, doc, flavour };
  const results: RuleResult[] = [];

  for (const rule of RULES) {
    if (rule.appliesToParts && !rule.appliesToParts.includes(flavour.part)) continue;
    let outcome: { passed: boolean; detail: string | null };
    try {
      outcome = rule.check(ctx);
    } catch (error) {
      outcome = {
        passed: false,
        detail: `Rule check errored: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    results.push({
      ruleId: rule.ruleId,
      clause: rule.clause,
      description: rule.description,
      passed: outcome.passed,
      detail: outcome.detail,
    });
  }

  return {
    flavour,
    allCheckedRulesPassed: results.every((r) => r.passed),
    results,
    notes: [
      `Native engine checks a SUBSET of ISO 19005 (${results.length} rules) — passing does not certify conformance. Install veraPDF for authoritative validation.`,
    ],
  };
}
