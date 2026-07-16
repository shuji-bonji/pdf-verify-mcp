/**
 * Conformance validation orchestration (v0.6, hybrid engine).
 *
 * Standards:
 * - PDF/A  (ISO 19005) — archival conformance
 * - PDF/UA (ISO 14289) — accessibility conformance (v0.6; previously delegated
 *   to pdf-reader-mcp's validate_tagged, which is a structure *inspection*
 *   rather than a conformance *judgment*)
 *
 * Engine selection:
 * - 'auto' (default): veraPDF when installed, otherwise the native subset
 * - 'verapdf': require veraPDF (error when unavailable)
 * - 'native': always use the native rule subset
 */

import { ValidationEngine } from '../constants.js';
import type { ParsedPdf } from '../types.js';
import { PdfVerifyError } from '../utils/error-handler.js';
import { extractPdfaId, extractPdfuaPart } from './conformance.js';
import { loadPdfDocument } from './pdf-parser.js';
import { type PdfaFlavour, resolveFlavour, validatePdfaNative } from './pdfa-validator.js';
import { type PdfuaFlavour, resolvePdfuaFlavour, validatePdfuaNative } from './pdfua-validator.js';
import { findVeraPdf, runVeraPdf } from './verapdf.js';

export interface ConformanceViolation {
  ruleId: string;
  clause: string;
  description: string;
  detail: string | null;
  /** PDF/UA native rules only: 'error' is definitive, 'warning' needs review */
  severity?: 'error' | 'warning';
}

export interface ConformanceValidationReport {
  engine: 'native' | 'verapdf';
  flavour: string;
  /**
   * true/false is definitive for veraPDF. For the native engine:
   * false when violations were found (definitive evidence of non-conformance),
   * null when all checked rules passed (subset cannot certify conformance).
   */
  compliant: boolean | null;
  checkedRules: number;
  passedRules: number;
  failedRules: number;
  violations: ConformanceViolation[];
  notes: string[];
}

function flavourLabel(flavour: PdfaFlavour): string {
  return `PDF/A-${flavour.part}${flavour.conformance ? flavour.conformance.toLowerCase() : ''}`;
}

function veraFlavourId(flavour: PdfaFlavour): string {
  return `${flavour.part}${(flavour.conformance ?? 'B').toLowerCase()}`;
}

/** veraPDF names the PDF/UA flavours ua1 / ua2 */
function veraPdfuaFlavourId(flavour: PdfuaFlavour): string {
  return `ua${flavour.part}`;
}

/** Is this flavour string asking for PDF/UA rather than PDF/A? */
function isPdfuaRequest(parsed: ParsedPdf, requested?: string): boolean {
  if (requested) return /^pdfua-/i.test(requested);
  // No explicit flavour: only auto-select PDF/UA when the document declares it
  // AND does not declare PDF/A (PDF/A takes precedence for backwards compatibility).
  const declaresUa = extractPdfuaPart(parsed.xmpMetadata) !== null;
  const declaresA = extractPdfaId(parsed.xmpMetadata) !== null;
  return declaresUa && !declaresA;
}

export interface ValidateConformanceOptions {
  /** e.g. 'pdfa-1b', 'pdfa-2b', 'pdfa-3b', 'pdfua-1', 'pdfua-2'. Omit to use the XMP declaration. */
  flavour?: string;
  engine?: ValidationEngine;
}

export async function validateConformance(
  parsed: ParsedPdf,
  filePath: string,
  options: ValidateConformanceOptions = {},
): Promise<ConformanceValidationReport> {
  const notes: string[] = [];

  const engineChoice = options.engine ?? ValidationEngine.AUTO;
  const veraPath = engineChoice === ValidationEngine.NATIVE ? null : await findVeraPdf();

  if (engineChoice === ValidationEngine.VERAPDF && !veraPath) {
    throw new PdfVerifyError(
      'veraPDF not found (set PDF_VERIFY_VERAPDF or add verapdf to PATH)',
      'VERAPDF_NOT_FOUND',
      'Install veraPDF from https://verapdf.org/ or use engine: "native"',
    );
  }

  if (isPdfuaRequest(parsed, options.flavour)) {
    return validatePdfua(parsed, filePath, options, veraPath, notes);
  }

  // A PDF/A validation was requested but the document also declares PDF/UA
  if (!options.flavour && extractPdfuaPart(parsed.xmpMetadata) !== null) {
    notes.push(
      'Document also declares PDF/UA. Pass flavour: "pdfua-1" (or "pdfua-2") to validate accessibility conformance.',
    );
  }

  let flavour = resolveFlavour(parsed, options.flavour);
  if (options.flavour && !flavour) {
    throw new PdfVerifyError(
      `Invalid flavour "${options.flavour}" (expected e.g. "pdfa-1b", "pdfa-2b", "pdfa-3b", "pdfua-1")`,
      'INVALID_FLAVOUR',
    );
  }
  if (!flavour) {
    flavour = { part: 2, conformance: 'B' };
    notes.push(
      'Document declares no PDF/A identification; validating against PDF/A-2b as a baseline. Pass flavour explicitly to override.',
    );
  }

  if (veraPath) {
    const report = await runVeraPdf(veraPath, filePath, veraFlavourId(flavour));
    return {
      engine: 'verapdf',
      flavour: flavourLabel(flavour),
      compliant: report.compliant,
      checkedRules: report.passedRules + report.failedRules,
      passedRules: report.passedRules,
      failedRules: report.failedRules,
      violations: report.violations.map((v) => ({
        ruleId: v.ruleId,
        clause: v.clause,
        description: v.description,
        detail: v.failedChecks > 0 ? `${v.failedChecks} failed check(s)` : null,
      })),
      notes: [...notes, `Validated by veraPDF (${veraPath}) — authoritative result.`],
    };
  }

  // Native subset
  const doc = await loadPdfDocument(parsed.bytes);
  const native = validatePdfaNative(parsed, doc, flavour);
  const failed = native.results.filter((r) => !r.passed);

  return {
    engine: 'native',
    flavour: flavourLabel(flavour),
    compliant: failed.length > 0 ? false : null,
    checkedRules: native.results.length,
    passedRules: native.results.length - failed.length,
    failedRules: failed.length,
    violations: failed.map((r) => ({
      ruleId: r.ruleId,
      clause: r.clause,
      description: r.description,
      detail: r.detail,
    })),
    notes: [...notes, ...native.notes],
  };
}

/**
 * PDF/UA (ISO 14289) validation.
 *
 * Kept separate from the PDF/A path: the rule sets, clause references and the
 * meaning of "compliant" differ, and PDF/UA has requirements that are only
 * partly machine-checkable (hence rule severity).
 */
async function validatePdfua(
  parsed: ParsedPdf,
  filePath: string,
  options: ValidateConformanceOptions,
  veraPath: string | null,
  notes: string[],
): Promise<ConformanceValidationReport> {
  let flavour = resolvePdfuaFlavour(parsed, options.flavour);
  if (options.flavour && !flavour) {
    throw new PdfVerifyError(
      `Invalid flavour "${options.flavour}" (expected "pdfua-1" or "pdfua-2")`,
      'INVALID_FLAVOUR',
    );
  }
  if (!flavour) {
    flavour = { part: 1 };
    notes.push(
      'Document declares no PDF/UA identification; validating against PDF/UA-1 as a baseline. Pass flavour explicitly to override.',
    );
  }

  if (veraPath) {
    const report = await runVeraPdf(veraPath, filePath, veraPdfuaFlavourId(flavour));
    return {
      engine: 'verapdf',
      flavour: `PDF/UA-${flavour.part}`,
      compliant: report.compliant,
      checkedRules: report.passedRules + report.failedRules,
      passedRules: report.passedRules,
      failedRules: report.failedRules,
      violations: report.violations.map((v) => ({
        ruleId: v.ruleId,
        clause: v.clause,
        description: v.description,
        detail: v.failedChecks > 0 ? `${v.failedChecks} failed check(s)` : null,
      })),
      notes: [
        ...notes,
        `Validated by veraPDF (${veraPath}) — authoritative result.`,
        'Machine validation cannot judge whether alt text and reading order are semantically appropriate; human review remains necessary.',
      ],
    };
  }

  const doc = await loadPdfDocument(parsed.bytes);
  const native = validatePdfuaNative(parsed, doc, flavour);
  const failed = native.results.filter((r) => !r.passed);
  const errors = failed.filter((r) => r.severity === 'error');

  return {
    engine: 'native',
    flavour: `PDF/UA-${flavour.part}`,
    // Only definitive violations (severity 'error') can prove non-conformance
    compliant: errors.length > 0 ? false : null,
    checkedRules: native.results.length,
    passedRules: native.results.length - failed.length,
    failedRules: failed.length,
    violations: failed.map((r) => ({
      ruleId: r.ruleId,
      clause: r.clause,
      description: r.description,
      detail: r.detail,
      severity: r.severity,
    })),
    notes: [...notes, ...native.notes],
  };
}
