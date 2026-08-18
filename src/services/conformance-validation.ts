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

import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDict } from 'pdf-lib';
import { ValidationEngine, VERAPDF_ENV } from '../constants.js';
import type { ParsedPdf } from '../types.js';
import { PdfVerifyError } from '../utils/error-handler.js';
import { extractPdfaId, extractPdfuaPart } from './conformance.js';
import { decryptDocumentBytes } from './decrypt-document.js';
import { loadPdfDocument, parsePdfBytes } from './pdf-parser.js';
import { type PdfaFlavour, resolveFlavour, validatePdfaNative } from './pdfa-validator.js';
import { type PdfuaFlavour, resolvePdfuaFlavour, validatePdfuaNative } from './pdfua-validator.js';
import { resolveVeraPdf, runVeraPdf, veraPdfVersion } from './verapdf.js';

export interface ConformanceViolation {
  ruleId: string;
  clause: string;
  description: string;
  detail: string | null;
  /** PDF/UA native rules only: 'error' is definitive, 'warning' needs review */
  severity?: 'error' | 'warning';
}

/**
 * Whether the authoritative validator actually ran, and why not when it did not.
 *
 * The native engine can disprove conformance but never certify it, so a report
 * produced without veraPDF is a *weaker* claim than one produced with it. Saying
 * only `engine: "native"` leaves the reader to infer that; this states it, and
 * names the reason so a misconfiguration is not read as "veraPDF is not
 * installed here" (anti-pattern: passing over what was not performed).
 */
export type AuthoritativeValidation =
  | {
      performed: true;
      validator: 'verapdf';
      path: string;
      /**
       * What the validator answers to `--version`, or null when it could not
       * be read. **Not derivable from `path`** —— measured 2026-08-18:
       * Homebrew's directory says `1.30.2` while veraPDF says `1.30.0`.
       * A rule count is only comparable across runs of the same build.
       */
      version: string | null;
    }
  | {
      performed: false;
      validator: 'verapdf';
      reason: 'not_installed' | 'configured_path_unusable' | 'native_engine_requested';
      detail: string;
    };

export interface ConformanceValidationReport {
  engine: 'native' | 'verapdf';
  /** Provenance of the verdict: which validator decided it, or why none did. */
  authoritativeValidation: AuthoritativeValidation;
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
  /**
   * Rules that could NOT be evaluated (encrypted document without a usable
   * password). Skipped rules are neither passes nor violations (Issue #7).
   */
  skippedRules?: number;
  violations: ConformanceViolation[];
  notes: string[];
}

function flavourLabel(flavour: PdfaFlavour): string {
  return `PDF/A-${flavour.part}${flavour.conformance ? flavour.conformance.toLowerCase() : ''}`;
}

/**
 * veraPDF profile ids: 1a…3u for parts 1-3, and 4 / 4e / 4f for part 4.
 * PDF/A-4 has no conformance level, so "4b" must never be produced — defaulting
 * an absent level to B is only right for the older parts.
 *
 * Exported for tests: this mapping is the one place where a wrong id turns into
 * an unknown-profile error from veraPDF rather than a validation result.
 */
export function veraFlavourId(flavour: PdfaFlavour): string {
  if (flavour.part === 4) {
    return `4${flavour.conformance ? flavour.conformance.toLowerCase() : ''}`;
  }
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
  /** e.g. 'pdfa-1b', 'pdfa-2b', 'pdfa-3b', 'pdfa-4', 'pdfa-4f', 'pdfua-1', 'pdfua-2'. Omit to use the XMP declaration. */
  flavour?: string;
  engine?: ValidationEngine;
  /**
   * Password for encrypted documents (PDF/UA validation only — PDF/A forbids
   * encryption outright, so an encrypted file is judged as-is). The empty
   * user password is always tried first, so permission-encrypted PDFs
   * validate fully without this option.
   */
  password?: string;
}

/** Look for the authoritative validator, honouring an explicit engine choice. */
async function resolveAuthoritativeValidation(
  engineChoice: ValidationEngine,
): Promise<AuthoritativeValidation> {
  if (engineChoice === ValidationEngine.NATIVE) {
    return {
      performed: false,
      validator: 'verapdf',
      reason: 'native_engine_requested',
      detail: 'engine: "native" was requested, so veraPDF was not consulted.',
    };
  }
  const availability = await resolveVeraPdf();
  if (availability.available) {
    return {
      performed: true,
      validator: 'verapdf',
      path: availability.path,
      version: await veraPdfVersion(availability.path),
    };
  }
  if (availability.reason === 'configured_path_unusable') {
    return {
      performed: false,
      validator: 'verapdf',
      reason: 'configured_path_unusable',
      detail: `${VERAPDF_ENV} points at ${availability.configuredPath} (${availability.detail}).`,
    };
  }
  return {
    performed: false,
    validator: 'verapdf',
    reason: 'not_installed',
    detail: `veraPDF was not found (${VERAPDF_ENV} is unset and no executable is on PATH).`,
  };
}

/**
 * The prose form of "this was performed, by which build".
 *
 * The version is part of the sentence rather than a footnote: a rule count
 * ("146 / 146") only means something alongside the build that counted them.
 *
 * Exported so the markdown formatter can recognise this exact note among
 * `report.notes` and move it above the counts instead of printing it twice.
 * Comparing the built string is deliberate — a flag saying "this note is the
 * veraPDF one" would be a second source of truth for the same fact.
 */
export function veraPdfNote(status: AuthoritativeValidation): string {
  if (!status.performed) return '';
  const build = status.version === null ? 'version unknown' : `version ${status.version}`;
  return `Validated by veraPDF (${status.path}, ${build}) — authoritative result.`;
}

/**
 * The prose form of "this was not performed".
 *
 * Both halves matter: what did not run, and what the verdict below is therefore
 * worth. A reader who sees only the first half tends to read the native result
 * as a lighter version of the same answer, which it is not.
 */
function notPerformedNote(status: Extract<AuthoritativeValidation, { performed: false }>): string {
  const consequence =
    'Authoritative validation was NOT performed. The result below comes from the native rule subset, which can disprove conformance but cannot certify it.';
  return status.reason === 'configured_path_unusable'
    ? `${status.detail} veraPDF was configured but could not be used, and no other executable was substituted for it. ${consequence}`
    : `${status.detail} ${consequence}`;
}

/** engine: "verapdf" was demanded and cannot be honoured — fail rather than quietly downgrade. */
function toVeraPdfUnavailableError(
  status: Extract<AuthoritativeValidation, { performed: false }>,
): PdfVerifyError {
  return status.reason === 'configured_path_unusable'
    ? new PdfVerifyError(
        `veraPDF is unavailable: ${status.detail}`,
        'VERAPDF_NOT_AVAILABLE',
        `Point ${VERAPDF_ENV} at an executable veraPDF, unset it to search PATH, or use engine: "native" (subset — cannot certify conformance)`,
      )
    : new PdfVerifyError(
        'veraPDF not found (set PDF_VERIFY_VERAPDF or add verapdf to PATH)',
        'VERAPDF_NOT_FOUND',
        'Install veraPDF from https://verapdf.org/ or use engine: "native"',
      );
}

export async function validateConformance(
  parsed: ParsedPdf,
  filePath: string,
  options: ValidateConformanceOptions = {},
): Promise<ConformanceValidationReport> {
  const notes: string[] = [];

  const engineChoice = options.engine ?? ValidationEngine.AUTO;
  const status = await resolveAuthoritativeValidation(engineChoice);
  const veraPath = status.performed ? status.path : null;

  if (engineChoice === ValidationEngine.VERAPDF && !status.performed) {
    throw toVeraPdfUnavailableError(status);
  }
  if (!status.performed) notes.push(notPerformedNote(status));

  if (isPdfuaRequest(parsed, options.flavour)) {
    return validatePdfua(parsed, filePath, options, engineChoice, veraPath, notes, status);
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
      `Invalid flavour "${options.flavour}" (expected e.g. "pdfa-1b", "pdfa-2b", "pdfa-3b", "pdfa-4", "pdfa-4e", "pdfa-4f", "pdfua-1"; PDF/A-4 has no A/B/U level, so "pdfa-4b" is not a flavour)`,
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
      authoritativeValidation: status,
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
      notes: [...notes, veraPdfNote(status)],
    };
  }

  // Native subset
  const doc = await loadPdfDocument(parsed.bytes);
  const native = validatePdfaNative(parsed, doc, flavour);
  const failed = native.results.filter((r) => !r.passed);

  return {
    engine: 'native',
    authoritativeValidation: status,
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
  engineChoice: ValidationEngine,
  veraPath: string | null,
  notes: string[],
  status: AuthoritativeValidation,
): Promise<ConformanceValidationReport> {
  // Issue #7: an encrypted document's structures (object streams, strings)
  // are ciphertext — validating them as-is produces false findings. Rebuild a
  // plaintext document first (the empty user password covers
  // permission-encrypted PDFs); when that fails, structure-dependent rules
  // are reported as "not checked" instead of failed.
  let target = parsed;
  let validationPath = filePath;
  let tempFile: string | null = null;
  let undecrypted = false;
  let encryptDict: PDFDict | null = null;

  if (parsed.isEncrypted) {
    const originalDoc = await loadPdfDocument(parsed.bytes);
    const enc = originalDoc.context.lookup(originalDoc.context.trailerInfo.Encrypt);
    encryptDict = enc instanceof PDFDict ? enc : null;

    const plain = await decryptDocumentBytes(parsed.bytes, options.password ?? '');
    if (plain && plain !== parsed.bytes) {
      target = await parsePdfBytes(plain);
      notes.push(
        'Encrypted document was decrypted before validation. ua-no-encryption-barrier is evaluated against the original encryption dictionary (ISO 14289-1, 7.16).',
      );
      if (veraPath) {
        tempFile = join(tmpdir(), `pdf-verify-decrypted-${randomBytes(8).toString('hex')}.pdf`);
        await writeFile(tempFile, plain);
        validationPath = tempFile;
      }
    } else if (!plain && options.password !== undefined) {
      throw new PdfVerifyError(
        'The supplied password is wrong, or the security handler is unsupported',
        'WRONG_PASSWORD',
        'Check the password; only the Standard security handler is supported',
      );
    } else if (!plain) {
      if (engineChoice === ValidationEngine.VERAPDF) {
        throw new PdfVerifyError(
          'Document is password-protected; veraPDF cannot validate it without decryption',
          'ENCRYPTED_PDF',
          'Supply the password parameter to enable full validation',
        );
      }
      undecrypted = true;
      veraPath = null; // veraPDF cannot read it either — fall back to native skip-mode
      notes.push(
        'Document is password-protected and could not be decrypted with the empty user password. Structure-dependent rules were NOT checked (reported as checked: false) — supply the password parameter to enable them.',
      );
    }
  }

  let flavour = resolvePdfuaFlavour(target, options.flavour);
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
    let report: Awaited<ReturnType<typeof runVeraPdf>>;
    try {
      report = await runVeraPdf(veraPath, validationPath, veraPdfuaFlavourId(flavour));
    } finally {
      if (tempFile) await unlink(tempFile).catch(() => {});
    }
    return {
      engine: 'verapdf',
      authoritativeValidation: status,
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
        veraPdfNote(status),
        'Machine validation cannot judge whether alt text and reading order are semantically appropriate; human review remains necessary.',
      ],
    };
  }

  const doc = await loadPdfDocument(target.bytes);
  const native = validatePdfuaNative(target, doc, flavour, {
    undecrypted,
    wasEncrypted: parsed.isEncrypted,
    encryptDict,
  });
  const checked = native.results.filter((r) => r.checked);
  const skipped = native.results.length - checked.length;
  const failed = checked.filter((r) => !r.passed);
  const errors = failed.filter((r) => r.severity === 'error');

  return {
    engine: 'native',
    authoritativeValidation: status,
    flavour: `PDF/UA-${flavour.part}`,
    // Only definitive violations (severity 'error') can prove non-conformance
    compliant: errors.length > 0 ? false : null,
    checkedRules: checked.length,
    passedRules: checked.length - failed.length,
    failedRules: failed.length,
    ...(skipped > 0 ? { skippedRules: skipped } : {}),
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
