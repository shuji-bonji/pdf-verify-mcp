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
  const pdfaPart = matchXmp(xmp, [
    /pdfaid:part\s*=\s*["'](\d+)["']/,
    /<pdfaid:part>\s*(\d+)\s*<\/pdfaid:part>/,
  ]);
  const pdfaConformance = matchXmp(xmp, [
    /pdfaid:conformance\s*=\s*["']([ABUabu])["']/,
    /<pdfaid:conformance>\s*([ABUabu])\s*<\/pdfaid:conformance>/,
  ]);
  const pdfuaPart = matchXmp(xmp, [
    /pdfuaid:part\s*=\s*["'](\d+)["']/,
    /<pdfuaid:part>\s*(\d+)\s*<\/pdfuaid:part>/,
  ]);

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
