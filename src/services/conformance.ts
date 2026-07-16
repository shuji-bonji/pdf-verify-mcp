/**
 * PDF/A / PDF/UA conformance declaration identification (v0.1).
 *
 * Reads the XMP metadata stream and reports declared conformance.
 * This is IDENTIFICATION only — full conformance validation (veraPDF-level)
 * is planned for a later phase. See docs/PROJECT_PLAN.md.
 */

import type { ConformanceReport, ParsedPdf } from '../types.js';

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
  const conformance = matchXmp(xmp, [
    /pdfaid:conformance\s*=\s*["']([ABUabu])["']/,
    /<pdfaid:conformance>\s*([ABUabu])\s*<\/pdfaid:conformance>/,
  ]);
  return { part: Number(part), conformance: conformance ? conformance.toUpperCase() : null };
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

export function identifyConformance(parsed: ParsedPdf): ConformanceReport {
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

  return {
    hasXmp: true,
    pdfA: pdfaPart ? { part: pdfaPart, conformance: pdfaConformance?.toUpperCase() ?? null } : null,
    pdfUa: pdfuaPart ? { part: pdfuaPart } : null,
    pdfVersion: parsed.pdfVersion,
    notes,
  };
}
