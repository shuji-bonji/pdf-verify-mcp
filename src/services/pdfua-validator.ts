/**
 * Native PDF/UA validation rule engine (v0.6).
 *
 * Implements a pragmatic SUBSET of ISO 14289 (PDF/UA) — the machine-checkable
 * structural requirements. Accessibility is only partly decidable by machine:
 * whether alt text is *present* can be checked, whether it is *meaningful*
 * cannot. Rules therefore carry a severity, and passing them all is "no
 * violations detected within the checked rule set", never "accessible".
 *
 * Prefer veraPDF (`--flavour ua1`) when available; see verapdf.ts.
 */

import {
  PDFArray,
  PDFBool,
  PDFDict,
  type PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
} from 'pdf-lib';
import type { ParsedPdf } from '../types.js';

/** PDF/UA flavour under validation */
export interface PdfuaFlavour {
  /** 1 | 2 (ISO 14289-1 / -2) */
  part: number;
}

export interface PdfuaRuleResult {
  ruleId: string;
  /** ISO 14289 clause reference */
  clause: string;
  description: string;
  passed: boolean;
  /**
   * 'error'   — a definitive PDF/UA violation
   * 'warning' — likely a problem, or a requirement only partly machine-checkable
   */
  severity: 'error' | 'warning';
  detail: string | null;
}

export interface PdfuaValidationReport {
  flavour: PdfuaFlavour;
  allCheckedRulesPassed: boolean;
  results: PdfuaRuleResult[];
  notes: string[];
}

interface RuleContext {
  parsed: ParsedPdf;
  doc: PDFDocument;
  flavour: PdfuaFlavour;
  /** Structure elements collected once, shared across rules */
  structElems: PDFDict[];
  /** Tag name -> count, after /RoleMap resolution */
  roleCounts: Record<string, number>;
}

interface Rule {
  ruleId: string;
  clause: string;
  description: string;
  severity: 'error' | 'warning';
  appliesToParts?: number[];
  check: (ctx: RuleContext) => { passed: boolean; detail: string | null };
}

// ---------------------------------------------------------------------------
// Structure tree helpers
// ---------------------------------------------------------------------------

/** Decode a PDF text string (literal or hex/UTF-16BE) */
function decodeText(value: unknown): string | null {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return null;
}

function structTreeRoot(doc: PDFDocument): PDFDict | null {
  const root = doc.catalog.lookup(PDFName.of('StructTreeRoot'));
  return root instanceof PDFDict ? root : null;
}

/**
 * Walk the structure tree from StructTreeRoot, collecting /StructElem dicts.
 * Cycles are guarded; the traversal order follows /K so heading order is preserved.
 */
function collectStructElems(doc: PDFDocument): PDFDict[] {
  const root = structTreeRoot(doc);
  if (!root) return [];

  const out: PDFDict[] = [];
  const seen = new Set<PDFDict>();

  const visitKids = (node: PDFDict): void => {
    const k = node.lookup(PDFName.of('K'));
    if (k instanceof PDFDict) visit(k);
    else if (k instanceof PDFArray) {
      for (let i = 0; i < k.size(); i++) {
        const kid = k.lookup(i);
        if (kid instanceof PDFDict) visit(kid);
      }
    }
  };

  const visit = (node: PDFDict): void => {
    if (seen.has(node)) return;
    seen.add(node);
    // Marked-content reference dicts (/Type /MCR, /OBJR) are not struct elements
    const type = node.lookup(PDFName.of('Type'));
    const isMcr = type instanceof PDFName && ['MCR', 'OBJR'].includes(type.decodeText());
    if (!isMcr && node.lookup(PDFName.of('S')) instanceof PDFName) out.push(node);
    visitKids(node);
  };

  visitKids(root);
  return out;
}

/** Resolve a struct element's tag through /RoleMap */
function tagOf(elem: PDFDict, roleMap: Map<string, string>): string {
  const s = elem.lookup(PDFName.of('S'));
  if (!(s instanceof PDFName)) return '';
  const raw = s.decodeText();
  return roleMap.get(raw) ?? raw;
}

function buildRoleMap(doc: PDFDocument): Map<string, string> {
  const map = new Map<string, string>();
  const root = structTreeRoot(doc);
  const rm = root?.lookup(PDFName.of('RoleMap'));
  if (rm instanceof PDFDict) {
    for (const [key, value] of rm.entries()) {
      if (value instanceof PDFName) map.set(key.decodeText(), value.decodeText());
    }
  }
  return map;
}

/** Count XObject images across pages (PDF/UA needs them tagged as Figure) */
function countImageXObjects(doc: PDFDocument): number {
  let count = 0;
  for (const page of doc.getPages()) {
    const resources = page.node.lookup(PDFName.of('Resources'));
    if (!(resources instanceof PDFDict)) continue;
    const xobjects = resources.lookup(PDFName.of('XObject'));
    if (!(xobjects instanceof PDFDict)) continue;
    for (const key of xobjects.keys()) {
      const xo = xobjects.lookup(key);
      if (xo instanceof PDFDict) {
        const subtype = xo.lookup(PDFName.of('Subtype'));
        if (subtype instanceof PDFName && subtype.decodeText() === 'Image') count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const RULES: Rule[] = [
  {
    ruleId: 'ua-marked',
    clause: 'ISO 14289-1, 7.1 (2)',
    description: 'The document catalog shall have MarkInfo with Marked set to true',
    severity: 'error',
    check: (ctx) => {
      const markInfo = ctx.doc.catalog.lookup(PDFName.of('MarkInfo'));
      if (!(markInfo instanceof PDFDict)) {
        return { passed: false, detail: 'No /MarkInfo dictionary in the catalog' };
      }
      const marked = markInfo.lookup(PDFName.of('Marked'));
      if (marked instanceof PDFBool && marked.asBoolean()) return { passed: true, detail: null };
      return { passed: false, detail: '/MarkInfo /Marked is not true' };
    },
  },
  {
    ruleId: 'ua-struct-tree',
    clause: 'ISO 14289-1, 7.1 (1)',
    description: 'The document catalog shall contain a StructTreeRoot',
    severity: 'error',
    check: (ctx) => {
      if (!structTreeRoot(ctx.doc)) {
        return { passed: false, detail: 'No /StructTreeRoot in the catalog' };
      }
      if (ctx.structElems.length === 0) {
        return { passed: false, detail: '/StructTreeRoot contains no structure elements' };
      }
      return { passed: true, detail: null };
    },
  },
  {
    ruleId: 'ua-xmp-declaration',
    clause: 'ISO 14289-1, 5',
    description: 'XMP metadata shall declare PDF/UA identification (pdfuaid:part)',
    severity: 'error',
    check: (ctx) => {
      const xmp = ctx.parsed.xmpMetadata;
      if (!xmp) return { passed: false, detail: 'No XMP metadata stream' };
      const m =
        /pdfuaid:part\s*=\s*["'](\d+)["']/.exec(xmp) ??
        /<pdfuaid:part>\s*(\d+)\s*<\/pdfuaid:part>/.exec(xmp);
      if (!m) return { passed: false, detail: 'XMP has no pdfuaid:part declaration' };
      if (Number(m[1]) !== ctx.flavour.part) {
        return {
          passed: false,
          detail: `XMP declares PDF/UA-${m[1]} but validation requested PDF/UA-${ctx.flavour.part}`,
        };
      }
      return { passed: true, detail: null };
    },
  },
  {
    ruleId: 'ua-lang',
    clause: 'ISO 14289-1, 7.2 (1)',
    description: 'A default natural language shall be declared (/Lang in the catalog)',
    severity: 'error',
    check: (ctx) => {
      const lang = decodeText(ctx.doc.catalog.lookup(PDFName.of('Lang')));
      if (!lang || lang.trim() === '') {
        return { passed: false, detail: 'No /Lang entry in the catalog' };
      }
      return { passed: true, detail: null };
    },
  },
  {
    ruleId: 'ua-display-doc-title',
    clause: 'ISO 14289-1, 7.1 (8)',
    description: 'ViewerPreferences shall set DisplayDocTitle to true',
    severity: 'error',
    check: (ctx) => {
      const vp = ctx.doc.catalog.lookup(PDFName.of('ViewerPreferences'));
      if (!(vp instanceof PDFDict)) {
        return { passed: false, detail: 'No /ViewerPreferences dictionary' };
      }
      const flag = vp.lookup(PDFName.of('DisplayDocTitle'));
      if (flag instanceof PDFBool && flag.asBoolean()) return { passed: true, detail: null };
      return { passed: false, detail: '/ViewerPreferences /DisplayDocTitle is not true' };
    },
  },
  {
    ruleId: 'ua-title',
    clause: 'ISO 14289-1, 7.1 (8)',
    description: 'The document shall have a title (XMP dc:title or Info /Title)',
    severity: 'error',
    check: (ctx) => {
      const xmp = ctx.parsed.xmpMetadata ?? '';
      const hasXmpTitle = /<dc:title>[\s\S]*?<rdf:li[^>]*>\s*\S/.test(xmp);
      const info = ctx.doc.context.lookup(ctx.doc.context.trailerInfo.Info);
      const infoTitle =
        info instanceof PDFDict ? decodeText(info.lookup(PDFName.of('Title'))) : null;
      if (hasXmpTitle || (infoTitle && infoTitle.trim() !== '')) {
        return { passed: true, detail: null };
      }
      return { passed: false, detail: 'Neither XMP dc:title nor Info /Title is set' };
    },
  },
  {
    ruleId: 'ua-figure-alt',
    clause: 'ISO 14289-1, 7.3',
    description: 'Every Figure structure element shall have alternate text (/Alt)',
    severity: 'error',
    check: (ctx) => {
      const figures = ctx.structElems.filter((e) => tagOf(e, buildRoleMapCached(ctx)) === 'Figure');
      if (figures.length === 0) return { passed: true, detail: null };
      const missing = figures.filter((f) => {
        const alt = decodeText(f.lookup(PDFName.of('Alt')));
        const actual = decodeText(f.lookup(PDFName.of('ActualText')));
        return !(alt && alt.trim() !== '') && !(actual && actual.trim() !== '');
      });
      if (missing.length === 0) return { passed: true, detail: null };
      return {
        passed: false,
        detail: `${missing.length} of ${figures.length} Figure element(s) have no /Alt or /ActualText`,
      };
    },
  },
  {
    ruleId: 'ua-images-tagged',
    clause: 'ISO 14289-1, 7.3',
    description: 'Images shall be tagged as Figure (or marked as artifacts)',
    severity: 'warning',
    check: (ctx) => {
      const images = countImageXObjects(ctx.doc);
      if (images === 0) return { passed: true, detail: null };
      const figures = ctx.roleCounts.Figure ?? 0;
      if (figures >= images) return { passed: true, detail: null };
      return {
        passed: false,
        detail: `${images} image XObject(s) but only ${figures} Figure tag(s) — untagged images must be artifacts (not machine-verifiable here)`,
      };
    },
  },
  {
    ruleId: 'ua-heading-hierarchy',
    clause: 'ISO 14289-1, 7.4.2',
    description: 'Headings shall start at H1 and not skip levels',
    severity: 'error',
    check: (ctx) => {
      const roleMap = buildRoleMapCached(ctx);
      const levels: number[] = [];
      for (const elem of ctx.structElems) {
        const m = /^H([1-6])$/.exec(tagOf(elem, roleMap));
        if (m) levels.push(Number(m[1]));
      }
      if (levels.length === 0) {
        // Strong structure (H1..H6) is optional if the flat 'H' tag is used
        if ((ctx.roleCounts.H ?? 0) > 0) return { passed: true, detail: null };
        return { passed: true, detail: null };
      }
      if (levels[0] !== 1) {
        return { passed: false, detail: `First heading is H${levels[0]}, expected H1` };
      }
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] - levels[i - 1] > 1) {
          return {
            passed: false,
            detail: `Heading level skipped: H${levels[i - 1]} followed by H${levels[i]}`,
          };
        }
      }
      return { passed: true, detail: null };
    },
  },
  {
    ruleId: 'ua-table-headers',
    clause: 'ISO 14289-1, 7.5',
    description: 'Tables shall have header cells (TH) and rows (TR)',
    severity: 'error',
    check: (ctx) => {
      const tables = ctx.roleCounts.Table ?? 0;
      if (tables === 0) return { passed: true, detail: null };
      const problems: string[] = [];
      if ((ctx.roleCounts.TR ?? 0) === 0) problems.push('no TR (table row) elements');
      if ((ctx.roleCounts.TH ?? 0) === 0) problems.push('no TH (header cell) elements');
      if (problems.length === 0) return { passed: true, detail: null };
      return { passed: false, detail: `${tables} Table element(s) but ${problems.join(' and ')}` };
    },
  },
  {
    ruleId: 'ua-link-contents',
    clause: 'ISO 14289-1, 7.18.5',
    description: 'Link annotations shall have an alternate description (/Contents)',
    severity: 'error',
    check: (ctx) => {
      let links = 0;
      let missing = 0;
      for (const page of ctx.doc.getPages()) {
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = 0; i < annots.size(); i++) {
          const a = annots.lookup(i);
          if (!(a instanceof PDFDict)) continue;
          const subtype = a.lookup(PDFName.of('Subtype'));
          if (!(subtype instanceof PDFName) || subtype.decodeText() !== 'Link') continue;
          links++;
          const contents = decodeText(a.lookup(PDFName.of('Contents')));
          if (!contents || contents.trim() === '') missing++;
        }
      }
      if (links === 0 || missing === 0) return { passed: true, detail: null };
      return {
        passed: false,
        detail: `${missing} of ${links} Link annotation(s) have no /Contents`,
      };
    },
  },
  {
    ruleId: 'ua-no-encryption-barrier',
    clause: 'ISO 14289-1, 7.1 (10)',
    description: 'Encryption shall not prevent assistive technology from extracting text',
    severity: 'warning',
    check: (ctx) => {
      if (!ctx.parsed.isEncrypted) return { passed: true, detail: null };
      return {
        passed: false,
        detail:
          'Document is encrypted — the accessibility permission bit could not be verified here',
      };
    },
  },
];

// RoleMap is derived per document; cache it on the context object.
const roleMapCache = new WeakMap<PDFDocument, Map<string, string>>();
function buildRoleMapCached(ctx: RuleContext): Map<string, string> {
  let map = roleMapCache.get(ctx.doc);
  if (!map) {
    map = buildRoleMap(ctx.doc);
    roleMapCache.set(ctx.doc, map);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Parse an explicit PDF/UA flavour string, or read it from XMP */
export function resolvePdfuaFlavour(parsed: ParsedPdf, requested?: string): PdfuaFlavour | null {
  if (requested) {
    const match = /^pdfua-([12])$/i.exec(requested);
    return match ? { part: Number(match[1]) } : null;
  }
  const xmp = parsed.xmpMetadata;
  if (!xmp) return null;
  const part =
    /pdfuaid:part\s*=\s*["'](\d+)["']/.exec(xmp) ??
    /<pdfuaid:part>\s*(\d+)\s*<\/pdfuaid:part>/.exec(xmp);
  return part ? { part: Number(part[1]) } : null;
}

export function validatePdfuaNative(
  parsed: ParsedPdf,
  doc: PDFDocument,
  flavour: PdfuaFlavour,
): PdfuaValidationReport {
  const structElems = collectStructElems(doc);
  const roleMap = buildRoleMap(doc);
  const roleCounts: Record<string, number> = {};
  for (const elem of structElems) {
    const tag = tagOf(elem, roleMap);
    if (tag) roleCounts[tag] = (roleCounts[tag] ?? 0) + 1;
  }

  const ctx: RuleContext = { parsed, doc, flavour, structElems, roleCounts };
  const results: PdfuaRuleResult[] = [];

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
      severity: rule.severity,
      passed: outcome.passed,
      detail: outcome.detail,
    });
  }

  return {
    flavour,
    allCheckedRulesPassed: results.every((r) => r.passed),
    results,
    notes: [
      `Native engine checks a SUBSET of ISO 14289 (${results.length} rules) — passing does not certify accessibility. Install veraPDF for authoritative validation.`,
      'Machine checks cannot judge whether alt text, reading order, or heading structure are semantically appropriate; human review remains necessary.',
    ],
  };
}
