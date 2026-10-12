/**
 * PDF/A / PDF/UA conformance declaration identification (v0.1).
 *
 * Reads the XMP metadata stream and reports declared conformance.
 * This is IDENTIFICATION only — full conformance validation (veraPDF-level)
 * is planned for a later phase. See docs/PROJECT_PLAN.md.
 */

import { toReadingScope } from '@normativepdf/recover';
import type { ConformanceReport, ParsedPdf } from '../types.js';
import { analyzeXmpNamespaces } from './xmp-schemas.js';

function matchXmp(xmp: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(xmp);
    if (match) return match[1];
  }
  return null;
}

/**
 * Extract the declared PDF/A identification (pdfaid:part / pdfaid:conformance)
 * from XMP metadata. Handles both the attribute and the element form. Shared
 * by conformance identification and PDF/A flavour resolution.
 *
 * pdfaid:conformance carries the conformance level A / B / U for parts 1-3 and
 * the variant E / F for part 4 (PDF/A-4 itself has no conformance level, so the
 * property is absent for plain PDF/A-4). The two vocabularies are kept apart:
 * a declaration pairing part 2 with "F", or part 4 with "B", is not a flavour
 * this validator can act on, so the variant is dropped rather than passed on to
 * veraPDF as a nonexistent profile id.
 */
export function extractPdfaId(
  xmp: string | null | undefined,
): { part: number; conformance: string | null } | null {
  if (!xmp) return null;
  const part = matchXmp(xmp, [
    /pdfaid:part\s*=\s*["'](\d+)["']/,
    /<pdfaid:part>\s*(\d+)\s*<\/pdfaid:part>/,
  ]);
  if (part === null) return null;
  const raw = matchXmp(xmp, [
    /pdfaid:conformance\s*=\s*["']([ABUEFabuef])["']/,
    /<pdfaid:conformance>\s*([ABUEFabuef])\s*<\/pdfaid:conformance>/,
  ]);
  const partNumber = Number(part);
  const upper = raw ? raw.toUpperCase() : null;
  const allowed = partNumber === 4 ? ['E', 'F'] : ['A', 'B', 'U'];
  return {
    part: partNumber,
    conformance: upper && allowed.includes(upper) ? upper : null,
  };
}

/**
 * Extract the declared PDF/UA part (pdfuaid:part) from XMP metadata.
 * Handles both the attribute and the element form. Shared by conformance
 * identification, PDF/UA flavour resolution, and the native rule engine.
 */
export function extractPdfuaPart(xmp: string | null | undefined): number | null {
  if (!xmp) return null;
  const part = matchXmp(xmp, [
    /pdfuaid:part\s*=\s*["'](\d+)["']/,
    /<pdfuaid:part>\s*(\d+)\s*<\/pdfuaid:part>/,
  ]);
  return part !== null ? Number(part) : null;
}

/**
 * 宣言の識別。`scope` は「どう読んだか」なので、判定の前に置いて返す
 * （下の `identify` は宣言だけを見る）。
 */
export function identifyConformance(parsed: ParsedPdf): ConformanceReport {
  return { scope: toReadingScope(parsed.scope), ...identify(parsed) };
}

function identify(parsed: ParsedPdf): Omit<ConformanceReport, 'scope'> {
  const notes: string[] = [
    'This tool identifies declared conformance only; it does not validate actual conformance.',
  ];
  const xmp = parsed.xmpMetadata;

  if (!xmp) {
    return {
      hasXmp: false,
      pdfA: null,
      pdfUa: null,
      pdfVersion: parsed.pdfVersion,
      xmpNamespaces: [],
      notes: [...notes, 'No XMP metadata stream found in the document catalog.'],
    };
  }

  // pdfaid:part / pdfaid:conformance — attribute or element form
  const pdfaId = extractPdfaId(xmp);
  const pdfaPart = pdfaId !== null ? String(pdfaId.part) : null;
  const pdfaConformance = pdfaId?.conformance ?? null;
  const pdfuaPartNum = extractPdfuaPart(xmp);
  const pdfuaPart = pdfuaPartNum !== null ? String(pdfuaPartNum) : null;

  if (pdfaPart) {
    notes.push(
      `Document declares PDF/A-${pdfaPart}${pdfaConformance ? pdfaConformance.toLowerCase() : ''}.`,
    );
  }
  if (pdfuaPart) {
    notes.push(`Document declares PDF/UA-${pdfuaPart}.`);
  }
  if (!pdfaPart && !pdfuaPart) {
    notes.push('No PDF/A or PDF/UA declaration found in XMP.');
  }

  // #23: which schemas the packet uses, and whether PDF/A would need them described.
  // An observation — the note below says what follows from it, not whether the file conforms.
  const xmpNamespaces = analyzeXmpNamespaces(xmp);
  const undescribed = xmpNamespaces.filter((n) => !n.predefined && !n.describedByExtensionSchema);
  if (pdfaPart && undescribed.length > 0) {
    notes.push(
      `The packet uses ${undescribed.length} namespace(s) that ISO 19005 does not predefine and that no pdfaExtension:schemas entry describes: ` +
        `${undescribed.map((n) => `${n.uri}${n.known ? ` (${n.known})` : ''}`).join(', ')}. ` +
        'A PDF/A validator reports this under ISO 19005-2 6.6.2.3 (19005-1: 6.7.8). This is what the packet declares, not a validation result — run validate_conformance.',
    );
  }

  return {
    hasXmp: true,
    pdfA: pdfaPart ? { part: pdfaPart, conformance: pdfaConformance?.toUpperCase() ?? null } : null,
    pdfUa: pdfuaPart ? { part: pdfuaPart } : null,
    pdfVersion: parsed.pdfVersion,
    xmpNamespaces,
    notes,
  };
}
