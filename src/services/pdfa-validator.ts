/**
 * Native PDF/A validation rule engine (v0.3).
 *
 * Implements a pragmatic SUBSET of ISO 19005 requirements — the rules that
 * catch the most common real-world violations. This is NOT a veraPDF
 * replacement: a document passing all native rules is "no violations
 * detected within the checked rule set", not "certified conformant".
 * When veraPDF is available it should be preferred (see verapdf.ts).
 */

import {
  asArray,
  asDict,
  boolOf,
  enumerateDicts,
  get,
  has,
  nameOf,
  resolved,
} from '@normativepdf/recover';
import type { CosDict, PdfDocument } from 'normativepdf';
import type { ParsedPdf } from '../types.js';
import { logger } from '../utils/logger.js';
import { extractPdfaId } from './conformance.js';
import { collectFontUsage } from './content-font-usage.js';

const CONTEXT = 'pdfa-validator';

/** PDF/A flavour under validation */
export interface PdfaFlavour {
  /** 1 | 2 | 3 | 4 */
  part: number;
  /**
   * Parts 1-3: the conformance level 'A' | 'B' | 'U' (null = unknown).
   * Part 4: PDF/A-4 has NO conformance level — this slot carries the variant
   * 'E' (engineering) or 'F' (embedded files), and null means plain PDF/A-4.
   *
   * The two vocabularies share one field because they share one slot in the
   * identification schema (pdfaid:conformance) and one position in veraPDF's
   * profile ids (2b / 4e). A second field would have to be kept in sync with
   * this one for no gain.
   */
  conformance: string | null;
}

/** Which pdfaid:conformance values are meaningful for a given part */
function allowedConformance(part: number): string[] {
  return part === 4 ? ['E', 'F'] : ['A', 'B', 'U'];
}

export interface RuleResult {
  ruleId: string;
  /** ISO 19005 clause reference */
  clause: string;
  description: string;
  passed: boolean;
  /**
   * false = **判定していない**（観測が足りない）。pass でも violation でもない。
   * PDF/UA 側（Issue #7 の `skippedRules`）と同じ語彙をここでも使う。
   * 🔴 `passed: false` と読まないこと —— 判定していないものを違反に数えると、
   * 「観測できなかった」が「違反だった」の顔をする。
   */
  checked: boolean;
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
  doc: PdfDocument;
  flavour: PdfaFlavour;
  /**
   * 間接オブジェクトのうち**辞書だけ**。1 度だけ数え上げて全規則で使い回す。
   * 🔴 ストリームの辞書は含めない —— pdf-lib 版の `instanceof PDFDict` と同じ範囲である。
   * 範囲を変えると、いままで見ていなかった辞書が規則の対象に入って判定が動く。
   */
  dicts: CosDict[];
  catalog: CosDict | null;
}

interface Rule {
  ruleId: string;
  clause: string;
  description: string;
  /** Restrict to certain parts (e.g. transparency ban is PDF/A-1 only) */
  appliesToParts?: number[];
  check: (ctx: RuleContext) => Promise<RuleOutcome>;
}

/** 規則 1 つの結果。`checked: false` は「判定していない」（既定は判定した） */
interface RuleOutcome {
  passed: boolean;
  detail: string | null;
  checked?: boolean;
}

/** Collect names used in /Filter entries across all streams */
function collectFilterNames(dicts: CosDict[]): Set<string> {
  const filters = new Set<string>();
  for (const dict of dicts) {
    const filter = get(dict, 'Filter');
    const single = nameOf(filter);
    if (single !== null) filters.add(single);
    const array = asArray(filter);
    if (array) {
      for (const item of array.items) {
        const name = nameOf(item);
        if (name !== null) filters.add(name);
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

/**
 * 描画に使われたフォントに、埋め込まれたフォントプログラムがあるか。
 *
 * 🔴 **「文書に在るフォント辞書」ではなく「文字を出したフォント」を見る。**
 * 0.24.0 まではすべての `/Type /Font` 辞書を数え上げていた。PDF/A が埋め込みを
 * 求めるのは描画に使われたフォントで、AcroForm の `/DR` に置いてあるだけの
 * `/Helv` `/ZaDb` や、テキストレンダリングモード 3（不可視・§9.3.6）でしか
 * 出さないフォントは対象外である。独立オラクル（veraPDF 1.30.2）と突き合わせると、
 * こちらだけが違反と言っていた検体が **106 件中 88 件**あった（2026-08-29 実測）。
 *
 * 3 つの答えを返す:
 *   fail        埋め込まれていないフォントが、モード 3 以外で文字を出している
 *   pass        すべて未使用かモード 3 だけ、**かつ観測が完全**
 *   not decided 観測が完全でない（`checked: false`）。pass でも violation でもない
 *
 * 🔴 観測が不完全でも、**すでに違反を 1 つ見つけていれば fail で確定する** ——
 * 見えている違反を「判定できない」に隠さない。
 */
async function checkFontsEmbedded(ctx: RuleContext): Promise<RuleOutcome> {
  const { usage, incomplete, reasons } = await collectFontUsage(ctx.doc);

  /** そのフォント辞書が文字を出したモード。使われていなければ空 */
  const modesOf = (font: CosDict): Set<number> => usage.get(font) ?? new Set<number>();

  const missing: string[] = [];
  let hadUnobservedCandidate = false;

  for (const dict of ctx.dicts) {
    if (nameOf(get(dict, 'Type')) !== 'Font') continue;
    const subtypeName = nameOf(get(dict, 'Subtype')) ?? '';
    // Type0 composite fonts delegate to descendant fonts (checked separately);
    // Type3 fonts have glyph procedures instead of font programs.
    if (subtypeName === 'Type0' || subtypeName === 'Type3') continue;

    const descriptor = asDict(await resolved(ctx.doc, get(dict, 'FontDescriptor')));
    const baseFontName = nameOf(get(dict, 'BaseFont')) ?? '(unknown)';
    const embedded =
      descriptor !== null &&
      (has(descriptor, 'FontFile') || has(descriptor, 'FontFile2') || has(descriptor, 'FontFile3'));
    if (embedded) continue;

    const modes = modesOf(dict);
    const visible = [...modes].some((mode) => mode !== 3);
    if (visible) {
      missing.push(
        `${baseFontName}${descriptor === null ? ` (no FontDescriptor${STANDARD_14.has(baseFontName) ? '; standard-14 fonts must be embedded in PDF/A' : ''})` : ''}`,
      );
      continue;
    }
    // 使われていない / モード 3 だけ。観測が完全ならこれは違反ではない
    if (modes.size === 0 && incomplete) hadUnobservedCandidate = true;
  }

  if (missing.length > 0) {
    return {
      passed: false,
      checked: true,
      detail: `Fonts rendered without an embedded program: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` (+${missing.length - 10} more)` : ''}`,
    };
  }
  if (hadUnobservedCandidate) {
    return {
      passed: false,
      checked: false,
      detail: `not decided — a font without an embedded program was found, but where it is used could not be observed: ${reasons.join('; ')}`,
    };
  }
  return { passed: true, checked: true, detail: null };
}

/** Search all dicts for any of the given keys */
function findDictsWithKey(dicts: CosDict[], keys: string[]): number {
  let count = 0;
  for (const dict of dicts) {
    for (const key of keys) {
      if (has(dict, key)) {
        count++;
        break;
      }
    }
  }
  return count;
}

/** Search for action dictionaries with prohibited /S values */
function findProhibitedActions(dicts: CosDict[], actions: string[]): string[] {
  const found = new Set<string>();
  for (const dict of dicts) {
    const s = nameOf(get(dict, 'S'));
    if (s !== null && actions.includes(s)) found.add(s);
  }
  return [...found];
}

const RULES: Rule[] = [
  {
    ruleId: 'no-encryption',
    clause: 'ISO 19005-1, 6.1.3',
    description: 'The trailer dictionary shall not contain an Encrypt entry',
    check: async (ctx) => ({
      passed: !ctx.parsed.isEncrypted,
      detail: ctx.parsed.isEncrypted ? 'Document is encrypted (/Encrypt present)' : null,
    }),
  },
  {
    ruleId: 'file-id',
    clause: 'ISO 19005-1, 6.1.3',
    description: 'The trailer dictionary shall contain an ID entry',
    check: async (ctx) => {
      const id = has(ctx.doc.trailer, 'ID');
      return {
        passed: id,
        detail: id ? null : 'Trailer /ID is missing',
      };
    },
  },
  {
    ruleId: 'no-lzw',
    clause: 'ISO 19005-1, 6.1.10',
    description: 'The LZWDecode filter shall not be used',
    check: async (ctx) => {
      const filters = collectFilterNames(ctx.dicts);
      const used = filters.has('LZWDecode');
      return { passed: !used, detail: used ? 'LZWDecode filter in use' : null };
    },
  },
  {
    ruleId: 'no-crypt-filter',
    clause: 'ISO 19005-2, 6.1.7',
    description: 'The Crypt filter shall not be used',
    check: async (ctx) => {
      const filters = collectFilterNames(ctx.dicts);
      const used = filters.has('Crypt');
      return { passed: !used, detail: used ? 'Crypt filter in use' : null };
    },
  },
  {
    ruleId: 'pdf-version',
    clause: 'ISO 19005-1, 6.1.2 / 19005-2, 6.1.2 / 19005-4, 6.1',
    description:
      'PDF version shall be within the allowed range (A-1: ≤1.4, A-2/A-3: ≤1.7, A-4: 2.0)',
    check: async (ctx) => {
      const version = Number.parseFloat(ctx.parsed.pdfVersion ?? '0');
      // PDF/A-4 is built on ISO 32000-2, so it does not take a range: the file
      // is a PDF 2.0 file or it is not one.
      if (ctx.flavour.part === 4) {
        const ok = version === 2.0;
        return {
          passed: ok,
          detail: ok
            ? null
            : `Header version ${ctx.parsed.pdfVersion} is not 2.0 (PDF/A-4 is based on PDF 2.0)`,
        };
      }
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
    check: async (ctx) => {
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
    description: 'A PDF/A OutputIntent (GTS_PDFA1) shall be present (PDF/A-1 to -3)',
    // Whether PDF/A-4 requires an OutputIntent unconditionally is not something
    // this family can read: ISO 19005-4 is outside the corpus (T2). Asserting
    // the -1..-3 requirement for -4 would manufacture a failure out of a guess,
    // so the question is left to the oracle (veraPDF) instead.
    appliesToParts: [1, 2, 3],
    check: async (ctx) => {
      const intents = asArray(await resolved(ctx.doc, get(ctx.catalog, 'OutputIntents')));
      if (intents) {
        for (const item of intents.items) {
          const intent = asDict(await resolved(ctx.doc, item));
          if (intent && nameOf(get(intent, 'S')) === 'GTS_PDFA1') {
            return { passed: true, detail: null };
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
    check: async (ctx) => {
      const count = findDictsWithKey(ctx.dicts, ['JS', 'JavaScript']);
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
    check: async (ctx) => {
      const found = findProhibitedActions(ctx.dicts, [
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
    check: async (ctx) => {
      const count = findDictsWithKey(ctx.dicts, ['EF']);
      const names = asDict(await resolved(ctx.doc, get(ctx.catalog, 'Names')));
      const hasEfTree = names !== null && has(names, 'EmbeddedFiles');
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
    check: async (ctx) => {
      let violations = 0;
      for (const dict of ctx.dicts) {
        const smask = get(dict, 'SMask');
        if (smask !== undefined && nameOf(smask) !== 'None') violations++;
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
    check: async (ctx) => {
      const acroForm = asDict(await resolved(ctx.doc, get(ctx.catalog, 'AcroForm')));
      const hasXfa = acroForm !== null && has(acroForm, 'XFA');
      return { passed: !hasXfa, detail: hasXfa ? 'AcroForm contains /XFA' : null };
    },
  },
  {
    ruleId: 'no-need-appearances',
    clause: 'ISO 19005-1, 6.9',
    description: 'AcroForm NeedAppearances shall be false or absent',
    check: async (ctx) => {
      const acroForm = asDict(await resolved(ctx.doc, get(ctx.catalog, 'AcroForm')));
      if (acroForm && boolOf(await resolved(ctx.doc, get(acroForm, 'NeedAppearances'))) === true) {
        return { passed: false, detail: 'AcroForm /NeedAppearances is true' };
      }
      return { passed: true, detail: null };
    },
  },
  {
    ruleId: 'no-aa-catalog',
    clause: 'ISO 19005-1, 6.6.2',
    description: 'The document catalog shall not contain an AA (additional actions) entry',
    check: async (ctx) => {
      const hasAa = has(ctx.catalog, 'AA');
      return { passed: !hasAa, detail: hasAa ? 'Catalog contains /AA' : null };
    },
  },
];

/** Number of rules in the native PDF/A subset (keeps tool descriptions accurate) */
export const PDFA_NATIVE_RULE_COUNT = RULES.length;

/**
 * Determine the flavour to validate: explicit request or the XMP declaration.
 *
 * Accepts "pdfa-1b" … "pdfa-3u" and, for PDF/A-4, "pdfa-4" / "pdfa-4e" /
 * "pdfa-4f". Combinations that name no real flavour ("pdfa-4b", "pdfa-2e")
 * are rejected here rather than handed to veraPDF as an unknown profile.
 */
export function resolveFlavour(parsed: ParsedPdf, requested?: string): PdfaFlavour | null {
  if (requested) {
    const match = /^pdfa-([1234])([abuef])?$/i.exec(requested);
    if (!match) return null;
    const part = Number(match[1]);
    const conformance = match[2]?.toUpperCase() ?? null;
    if (conformance && !allowedConformance(part).includes(conformance)) return null;
    return { part, conformance };
  }
  return extractPdfaId(parsed.xmpMetadata);
}

/** Run the native rule subset against a parsed document */
export async function validatePdfaNative(
  parsed: ParsedPdf,
  doc: PdfDocument,
  flavour: PdfaFlavour,
): Promise<NativeValidationReport> {
  const { dicts } = await enumerateDicts(doc);
  const catalog = asDict(await doc.getCatalog().catch(() => null));
  const ctx: RuleContext = { parsed, doc, flavour, dicts, catalog };
  const results: RuleResult[] = [];

  for (const rule of RULES) {
    if (rule.appliesToParts && !rule.appliesToParts.includes(flavour.part)) continue;
    let outcome: RuleOutcome;
    try {
      outcome = await rule.check(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(CONTEXT, `rule ${rule.ruleId} threw: ${message}`);
      outcome = {
        passed: false,
        detail: `Rule check errored: ${message}`,
      };
    }
    results.push({
      ruleId: rule.ruleId,
      clause: rule.clause,
      description: rule.description,
      passed: outcome.passed,
      checked: outcome.checked ?? true,
      detail: outcome.detail,
    });
  }

  const undecided = results.filter((r) => !r.checked);
  const notes = [
    `Native engine checks a SUBSET of ISO 19005 (${results.length} rules) — passing does not certify conformance. Install veraPDF for authoritative validation.`,
  ];
  if (undecided.length > 0) {
    notes.push(
      `${undecided.length} rule(s) were NOT decided because the document could not be observed far enough: ${undecided
        .map((r) => `${r.ruleId} (${r.detail ?? 'no detail'})`)
        .join('; ')}. A rule that was not decided is neither a pass nor a violation.`,
    );
  }
  if (flavour.part === 4) {
    notes.push(
      'PDF/A-4: these native rules were derived from ISO 19005-1/-2 and have NOT been checked against ISO 19005-4, which is outside the corpus of this family. Treat every native PDF/A-4 result as a hint that ranks below veraPDF, and validate with engine: "verapdf".',
    );
  }

  return {
    flavour,
    allCheckedRulesPassed: results.every((r) => !r.checked || r.passed),
    results,
    notes,
  };
}
