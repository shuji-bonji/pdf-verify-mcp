/**
 * PDF/A conformance validation orchestration (v0.3, hybrid engine).
 *
 * Engine selection:
 * - 'auto' (default): veraPDF when installed, otherwise the native subset
 * - 'verapdf': require veraPDF (error when unavailable)
 * - 'native': always use the native rule subset
 */

import { PDFDocument } from 'pdf-lib';
import { ValidationEngine } from '../constants.js';
import type { ParsedPdf } from '../types.js';
import { PdfVerifyError } from '../utils/error-handler.js';
import { type PdfaFlavour, resolveFlavour, validatePdfaNative } from './pdfa-validator.js';
import { findVeraPdf, runVeraPdf } from './verapdf.js';

export interface ConformanceViolation {
  ruleId: string;
  clause: string;
  description: string;
  detail: string | null;
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

export interface ValidateConformanceOptions {
  /** e.g. 'pdfa-1b', 'pdfa-2b', 'pdfa-3b'. Omit to use the XMP declaration. */
  flavour?: string;
  engine?: ValidationEngine;
}

export async function validateConformance(
  parsed: ParsedPdf,
  filePath: string,
  options: ValidateConformanceOptions = {},
): Promise<ConformanceValidationReport> {
  const notes: string[] = [];

  // PDF/UA is the pdf-reader-mcp family's responsibility
  if (parsed.xmpMetadata?.includes('pdfuaid:part')) {
    notes.push(
      "Document declares PDF/UA. For accessibility (tagged PDF) validation use pdf-reader-mcp's validate_tagged tool — PDF/UA is out of scope here.",
    );
  }

  let flavour = resolveFlavour(parsed, options.flavour);
  if (options.flavour && !flavour) {
    throw new PdfVerifyError(
      `Invalid flavour "${options.flavour}" (expected e.g. "pdfa-1b", "pdfa-2b", "pdfa-3b")`,
      'INVALID_FLAVOUR',
    );
  }
  if (!flavour) {
    flavour = { part: 2, conformance: 'B' };
    notes.push(
      'Document declares no PDF/A identification; validating against PDF/A-2b as a baseline. Pass flavour explicitly to override.',
    );
  }

  const engineChoice = options.engine ?? ValidationEngine.AUTO;
  const veraPath = engineChoice === ValidationEngine.NATIVE ? null : await findVeraPdf();

  if (engineChoice === ValidationEngine.VERAPDF && !veraPath) {
    throw new PdfVerifyError(
      'veraPDF not found (set PDF_VERIFY_VERAPDF or add verapdf to PATH)',
      'VERAPDF_NOT_FOUND',
      'Install veraPDF from https://verapdf.org/ or use engine: "native"',
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
  const doc = await PDFDocument.load(parsed.bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
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
