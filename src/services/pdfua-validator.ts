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

import { type CosDict, type CosObject, type PdfDocument, readPageTree } from 'normativepdf';
import type { ParsedPdf } from '../types.js';
import { logger } from '../utils/logger.js';
import { extractPdfuaPart } from './conformance.js';
import { asArray, asDict, boolOf, get, nameOf, numberOf, resolved, textOf } from './cos.js';

const CONTEXT = 'pdfua-validator';

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
   * false when the rule could not be evaluated (encrypted document that could
   * not be decrypted). A skipped rule is neither a pass nor a violation.
   */
  checked: boolean;
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
  doc: PdfDocument;
  flavour: PdfuaFlavour;
  /** Structure elements collected once, shared across rules */
  structElems: CosDict[];
  /** /RoleMap built once, shared across rules */
  roleMap: Map<string, string>;
  /** Tag name -> count, after /RoleMap resolution */
  roleCounts: Record<string, number>;
  /**
   * Whether the ORIGINAL document is encrypted, and its /Encrypt dictionary.
   * When validation runs on decrypted bytes, `doc` has no /Encrypt anymore —
   * ua-no-encryption-barrier must still judge the original (§7.16).
   */
  wasEncrypted: boolean;
  encryptDict: CosDict | null;
  /** The document catalog, resolved once */
  catalog: CosDict | null;
  /** Pages in §7.7.3 order, walked once (`doc.getPages()` の置き換え) */
  pages: CosDict[];
}

interface Rule {
  ruleId: string;
  clause: string;
  description: string;
  severity: 'error' | 'warning';
  appliesToParts?: number[];
  /**
   * true when the rule can be evaluated on an encrypted document that could
   * not be decrypted (only the /Encrypt dictionary is guaranteed readable —
   * everything else is ciphertext and would produce false findings).
   */
  worksOnEncrypted?: boolean;
  check: (ctx: RuleContext) => Promise<{ passed: boolean; detail: string | null }>;
}

// ---------------------------------------------------------------------------
// Structure tree helpers
// ---------------------------------------------------------------------------

/**
 * テキスト文字列（§7.9.2）。pdf-lib 1.x は UTF-8 のバイト順マーク（R-7.9.2.2.1-4・PDF 2.0）を
 * 扱わず、`ï»¿` の付いた文字列を返していた。`/Lang` `/Alt` `/Title` はここを通る。
 */
function decodeText(value: CosObject | null | undefined): string | null {
  return textOf(value);
}

async function structTreeRoot(doc: PdfDocument, catalog: CosDict | null): Promise<CosDict | null> {
  return asDict(await resolved(doc, get(catalog, 'StructTreeRoot')));
}

/**
 * Walk the structure tree from StructTreeRoot, collecting /StructElem dicts.
 * Cycles are guarded. The walk is iterative (explicit stack) so deeply nested
 * trees cannot overflow the call stack; kids are pushed in reverse so the
 * document order of /K is preserved (headings depend on it).
 *
 * 🔴 巡回の見張りは**参照の番号**で持つ。pdf-lib 版は辞書のオブジェクト同一性で
 * 見ていたが、normativepdf の `resolve` は呼ぶたびに値を作るので同一性では止まらない。
 * 直接オブジェクトは自分を指せないので、番号の無い枝は巡回しない。
 */
async function collectStructElems(doc: PdfDocument, catalog: CosDict | null): Promise<CosDict[]> {
  const root = await structTreeRoot(doc, catalog);
  if (!root) return [];

  const out: CosDict[] = [];
  const seen = new Set<number>();

  const kidsOf = async (node: CosDict): Promise<{ ref: number | null; dict: CosDict }[]> => {
    const k = await resolved(doc, get(node, 'K'));
    const direct = asDict(k);
    if (direct) return [{ ref: refNumber(get(node, 'K')), dict: direct }];
    const array = asArray(k);
    if (!array) return [];
    const kids: { ref: number | null; dict: CosDict }[] = [];
    for (const item of array.items) {
      const dict = asDict(await resolved(doc, item));
      if (dict) kids.push({ ref: refNumber(item), dict });
    }
    return kids;
  };

  const stack = (await kidsOf(root)).reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.ref !== null) {
      if (seen.has(node.ref)) continue;
      seen.add(node.ref);
    }
    // Marked-content reference dicts (/Type /MCR, /OBJR) are not struct elements
    const type = nameOf(await resolved(doc, get(node.dict, 'Type')));
    const isMcr = type !== null && ['MCR', 'OBJR'].includes(type);
    const s = await resolved(doc, get(node.dict, 'S'));
    if (!isMcr && nameOf(s) !== null) out.push(node.dict);
    const kids = await kidsOf(node.dict);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

function refNumber(value: CosObject | undefined): number | null {
  return value?.kind === 'ref' ? value.objectNumber : null;
}

/** Resolve a struct element's tag through /RoleMap */
function tagOf(elem: CosDict, roleMap: Map<string, string>): string {
  const raw = nameOf(get(elem, 'S'));
  if (raw === null) return '';
  return roleMap.get(raw) ?? raw;
}

async function buildRoleMap(
  doc: PdfDocument,
  catalog: CosDict | null,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const root = await structTreeRoot(doc, catalog);
  const rm = asDict(await resolved(doc, get(root, 'RoleMap')));
  if (rm) {
    for (const [key, value] of rm.entries) {
      const name = nameOf(value);
      if (name !== null) map.set(key, name);
    }
  }
  return map;
}

/**
 * Count XObject images across pages (PDF/UA needs them tagged as Figure).
 * ページ自身の `/Resources` だけを見る（継承は辿らない）—— pdf-lib 版と同じ範囲。
 */
async function countImageXObjects(doc: PdfDocument, pages: CosDict[]): Promise<number> {
  let count = 0;
  for (const page of pages) {
    const resources = asDict(await resolved(doc, get(page, 'Resources')));
    if (!resources) continue;
    const xobjects = asDict(await resolved(doc, get(resources, 'XObject')));
    if (!xobjects) continue;
    for (const [, value] of xobjects.entries) {
      const xo = asDict(await resolved(doc, value));
      if (xo && nameOf(await resolved(doc, get(xo, 'Subtype'))) === 'Image') count++;
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
    check: async (ctx) => {
      const markInfo = asDict(await resolved(ctx.doc, get(ctx.catalog, 'MarkInfo')));
      if (!markInfo) {
        return { passed: false, detail: 'No /MarkInfo dictionary in the catalog' };
      }
      const marked = boolOf(await resolved(ctx.doc, get(markInfo, 'Marked')));
      if (marked === true) return { passed: true, detail: null };
      return { passed: false, detail: '/MarkInfo /Marked is not true' };
    },
  },
  {
    ruleId: 'ua-struct-tree',
    clause: 'ISO 14289-1, 7.1 (1)',
    description: 'The document catalog shall contain a StructTreeRoot',
    severity: 'error',
    check: async (ctx) => {
      if (!(await structTreeRoot(ctx.doc, ctx.catalog))) {
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
    check: async (ctx) => {
      const xmp = ctx.parsed.xmpMetadata;
      if (!xmp) return { passed: false, detail: 'No XMP metadata stream' };
      const declared = extractPdfuaPart(xmp);
      if (declared === null) {
        return { passed: false, detail: 'XMP has no pdfuaid:part declaration' };
      }
      if (declared !== ctx.flavour.part) {
        return {
          passed: false,
          detail: `XMP declares PDF/UA-${declared} but validation requested PDF/UA-${ctx.flavour.part}`,
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
    check: async (ctx) => {
      const lang = decodeText(await resolved(ctx.doc, get(ctx.catalog, 'Lang')));
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
    check: async (ctx) => {
      const vp = asDict(await resolved(ctx.doc, get(ctx.catalog, 'ViewerPreferences')));
      if (!vp) {
        return { passed: false, detail: 'No /ViewerPreferences dictionary' };
      }
      const flag = boolOf(await resolved(ctx.doc, get(vp, 'DisplayDocTitle')));
      if (flag === true) return { passed: true, detail: null };
      return { passed: false, detail: '/ViewerPreferences /DisplayDocTitle is not true' };
    },
  },
  {
    ruleId: 'ua-title',
    clause: 'ISO 14289-1, 7.1',
    description:
      'The Metadata stream shall contain a dc:title entry (Info /Title alone does not conform — conforming readers ignore the document information dictionary)',
    severity: 'error',
    check: async (ctx) => {
      const xmp = ctx.parsed.xmpMetadata ?? '';
      const hasXmpTitle = /<dc:title>[\s\S]*?<rdf:li[^>]*>\s*\S/.test(xmp);
      if (hasXmpTitle) return { passed: true, detail: null };
      const info = asDict(await resolved(ctx.doc, get(ctx.doc.trailer, 'Info')));
      const infoTitle = info ? decodeText(await resolved(ctx.doc, get(info, 'Title'))) : null;
      if (infoTitle && infoTitle.trim() !== '') {
        return {
          passed: false,
          detail:
            'Info /Title is set but XMP has no dc:title — ISO 14289-1, 7.1 requires dc:title in the Metadata stream, and an ISO 14289-1 conforming reader shall ignore the document information dictionary',
        };
      }
      return { passed: false, detail: 'XMP metadata has no dc:title entry' };
    },
  },
  {
    ruleId: 'ua-figure-alt',
    clause: 'ISO 14289-1, 7.3',
    description: 'Every Figure structure element shall have alternate text (/Alt)',
    severity: 'error',
    check: async (ctx) => {
      const figures = ctx.structElems.filter((e) => tagOf(e, ctx.roleMap) === 'Figure');
      if (figures.length === 0) return { passed: true, detail: null };
      const missing: CosDict[] = [];
      for (const f of figures) {
        const alt = decodeText(await resolved(ctx.doc, get(f, 'Alt')));
        const actual = decodeText(await resolved(ctx.doc, get(f, 'ActualText')));
        if (!(alt && alt.trim() !== '') && !(actual && actual.trim() !== '')) missing.push(f);
      }
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
    check: async (ctx) => {
      const images = await countImageXObjects(ctx.doc, ctx.pages);
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
    description:
      'Headings shall start at H1 and not skip levels (checked in document order across the whole tree; branch-local level restarts are not distinguished and may be flagged)',
    severity: 'error',
    check: async (ctx) => {
      const levels: number[] = [];
      for (const elem of ctx.structElems) {
        const m = /^H([1-6])$/.exec(tagOf(elem, ctx.roleMap));
        if (m) levels.push(Number(m[1]));
      }
      // No numbered headings: the flat 'H' tag (or no headings at all) is fine
      if (levels.length === 0) return { passed: true, detail: null };
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
    check: async (ctx) => {
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
    check: async (ctx) => {
      let links = 0;
      let missing = 0;
      for (const page of ctx.pages) {
        const annots = asArray(await resolved(ctx.doc, get(page, 'Annots')));
        if (!annots) continue;
        for (const item of annots.items) {
          const a = asDict(await resolved(ctx.doc, item));
          if (!a) continue;
          if (nameOf(await resolved(ctx.doc, get(a, 'Subtype'))) !== 'Link') continue;
          links++;
          const contents = decodeText(await resolved(ctx.doc, get(a, 'Contents')));
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
    clause: 'ISO 14289-1, 7.16',
    description:
      'An encrypted file shall contain a P key whose 10th bit position (assistive-technology access) is true',
    severity: 'error',
    worksOnEncrypted: true,
    check: async (ctx) => {
      if (!ctx.wasEncrypted) return { passed: true, detail: null };
      const enc = ctx.encryptDict;
      if (!enc) {
        return {
          passed: false,
          detail: 'Document is encrypted but the /Encrypt dictionary could not be read',
        };
      }
      const pValue = numberOf(await resolved(ctx.doc, get(enc, 'P')));
      if (pValue === null) {
        return {
          passed: false,
          detail:
            'Encryption dictionary has no numeric /P key — ISO 14289-1, 7.16 requires a P key with bit 10 true',
        };
      }
      // Bit positions are 1-based (LSB = bit 1); bit 10 => mask 1 << 9
      if ((pValue & 0x200) !== 0) return { passed: true, detail: null };
      return {
        passed: false,
        detail: `/Encrypt /P bit 10 (copy for accessibility) is not set (P = ${pValue})`,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Number of rules in the native PDF/UA subset (keeps tool descriptions accurate) */
export const PDFUA_NATIVE_RULE_COUNT = RULES.length;

/** Parse an explicit PDF/UA flavour string, or read it from XMP */
export function resolvePdfuaFlavour(parsed: ParsedPdf, requested?: string): PdfuaFlavour | null {
  if (requested) {
    const match = /^pdfua-([12])$/i.exec(requested);
    return match ? { part: Number(match[1]) } : null;
  }
  const part = extractPdfuaPart(parsed.xmpMetadata);
  return part !== null ? { part } : null;
}

export interface PdfuaValidationOptions {
  /**
   * The document is encrypted and could not be decrypted: only rules marked
   * worksOnEncrypted run; the rest are reported as checked: false (a skipped
   * rule is neither a pass nor a violation).
   */
  undecrypted?: boolean;
  /** Whether the ORIGINAL document is encrypted (defaults to parsed.isEncrypted) */
  wasEncrypted?: boolean;
  /** /Encrypt dictionary of the ORIGINAL document (defaults to doc's trailer) */
  encryptDict?: CosDict | null;
}

export async function validatePdfuaNative(
  parsed: ParsedPdf,
  doc: PdfDocument,
  flavour: PdfuaFlavour,
  options: PdfuaValidationOptions = {},
): Promise<PdfuaValidationReport> {
  const catalog = asDict(await doc.getCatalog().catch(() => null));
  const structElems = await collectStructElems(doc, catalog);
  const roleMap = await buildRoleMap(doc, catalog);
  const roleCounts: Record<string, number> = {};
  for (const elem of structElems) {
    const tag = tagOf(elem, roleMap);
    if (tag) roleCounts[tag] = (roleCounts[tag] ?? 0) + 1;
  }

  const tree = await readPageTree(doc).catch(() => null);
  const pages = tree ? tree.pages.map((page) => page.dict) : [];

  let encryptDict = options.encryptDict ?? null;
  if (encryptDict === null && options.encryptDict === undefined) {
    encryptDict = asDict(await resolved(doc, get(doc.trailer, 'Encrypt')));
  }

  const ctx: RuleContext = {
    parsed,
    doc,
    flavour,
    structElems,
    roleMap,
    roleCounts,
    wasEncrypted: options.wasEncrypted ?? parsed.isEncrypted,
    encryptDict,
    catalog,
    pages,
  };
  const results: PdfuaRuleResult[] = [];

  for (const rule of RULES) {
    if (rule.appliesToParts && !rule.appliesToParts.includes(flavour.part)) continue;

    if (options.undecrypted && !rule.worksOnEncrypted) {
      results.push({
        ruleId: rule.ruleId,
        clause: rule.clause,
        description: rule.description,
        severity: rule.severity,
        passed: false,
        checked: false,
        detail:
          'Not checked: the document is encrypted and could not be decrypted, so the required structures are not readable. Supply the password to enable this check.',
      });
      continue;
    }

    let outcome: { passed: boolean; detail: string | null };
    try {
      outcome = await rule.check(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(CONTEXT, `rule ${rule.ruleId} threw: ${message}`);
      outcome = {
        passed: false,
        detail: `Rule check could not complete (the document structure may be malformed or unreadable): ${message}`,
      };
    }
    results.push({
      ruleId: rule.ruleId,
      clause: rule.clause,
      description: rule.description,
      severity: rule.severity,
      passed: outcome.passed,
      checked: true,
      detail: outcome.detail,
    });
  }

  const checked = results.filter((r) => r.checked);
  const skipped = results.length - checked.length;
  const notes = [
    `Native engine checks a SUBSET of ISO 14289 (${results.length} rules) — passing does not certify accessibility. Install veraPDF for authoritative validation.`,
    'Machine checks cannot judge whether alt text, reading order, or heading structure are semantically appropriate; human review remains necessary.',
  ];
  if (skipped > 0) {
    notes.push(
      `${skipped} rule(s) were NOT checked because the document is encrypted and could not be decrypted. Their absence from the violations is not evidence of conformance.`,
    );
  }

  return {
    flavour,
    allCheckedRulesPassed: checked.every((r) => r.passed),
    results,
    notes,
  };
}
