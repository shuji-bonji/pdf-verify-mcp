/**
 * Verification orchestration: combines pdf-parser and cms-verifier
 * into the reports returned by the MCP tools.
 */

import { DOCMDP_PERMISSIONS, PadesLevel, SUB_FILTER, Verdict, WEAK_DIGESTS } from '../constants.js';
import type {
  IntegrityReport,
  PadesLevelReport,
  ParsedPdf,
  SignatureField,
  SignatureVerificationReport,
} from '../types.js';
import { verifyCms, verifyTimestampImprint } from './cms-verifier.js';
import { coversEntireFile, extractSignedBytes } from './pdf-parser.js';

function bytesAfterRange(fileSize: number, byteRange: number[] | null): number | null {
  if (byteRange?.length !== 4) return null;
  return fileSize - (byteRange[2] + byteRange[3]);
}

/** Verify all signatures in the document */
export async function verifySignatures(parsed: ParsedPdf): Promise<SignatureVerificationReport[]> {
  const reports: SignatureVerificationReport[] = [];

  for (const sig of parsed.signatures) {
    const notes: string[] = [];
    const report: SignatureVerificationReport = {
      fieldName: sig.fieldName,
      subFilter: sig.subFilter,
      verdict: Verdict.INDETERMINATE,
      trust: 'not_evaluated',
      coversEntireFile: null,
      bytesAfterSignedRange: null,
      cms: null,
      signingTimeDictionary: sig.signingTimeDictionary,
      reason: sig.reason,
      location: sig.location,
      isDocumentTimestamp: sig.isDocumentTimestamp,
      notes,
    };

    if (parsed.isEncrypted) {
      notes.push(
        'Document is encrypted: string metadata (field name, /M, /Reason, /Location) is not decodable without decryption and was omitted. Cryptographic verification is unaffected.',
      );
    }

    if (!sig.byteRange || !sig.contents || sig.contents.length === 0) {
      notes.push('Signature field is unsigned or missing ByteRange/Contents.');
      reports.push(report);
      continue;
    }

    report.coversEntireFile = coversEntireFile(parsed.fileSize, sig.byteRange);
    report.bytesAfterSignedRange = bytesAfterRange(parsed.fileSize, sig.byteRange);

    let signedBytes: Uint8Array;
    try {
      signedBytes = extractSignedBytes(parsed.bytes, sig.byteRange);
    } catch (error) {
      report.verdict = Verdict.INVALID;
      notes.push(`ByteRange is invalid: ${error instanceof Error ? error.message : String(error)}`);
      reports.push(report);
      continue;
    }

    if (sig.isDocumentTimestamp || sig.subFilter === SUB_FILTER.ETSI_RFC3161) {
      const imprintMatches = await verifyTimestampImprint(sig.contents, signedBytes);
      const cms = await verifyCms(sig.contents, signedBytes);
      report.cms = cms;
      cms.digestMatches = imprintMatches;
      if (imprintMatches === false) {
        report.verdict = Verdict.INVALID;
        notes.push(
          'Timestamp messageImprint does not match the signed bytes — possible tampering.',
        );
      } else if (imprintMatches === true && cms.signatureVerified) {
        report.verdict = Verdict.VALID;
        notes.push('Document timestamp verified. TSA trust was not evaluated.');
      } else {
        notes.push('Document timestamp could not be fully verified.');
      }
      reports.push(report);
      continue;
    }

    if (
      sig.subFilter !== SUB_FILTER.ADBE_PKCS7_DETACHED &&
      sig.subFilter !== SUB_FILTER.ETSI_CADES_DETACHED
    ) {
      notes.push(
        `SubFilter "${sig.subFilter ?? '(none)'}" is not supported in v0.1 ` +
          `(supported: adbe.pkcs7.detached, ETSI.CAdES.detached, ETSI.RFC3161).`,
      );
      reports.push(report);
      continue;
    }

    const cms = await verifyCms(sig.contents, signedBytes);
    report.cms = cms;

    if (cms.digestMatches === false) {
      report.verdict = Verdict.INVALID;
      notes.push(
        'ByteRange digest does not match the CMS messageDigest — the signed bytes were altered.',
      );
    } else if (!cms.signatureVerified) {
      report.verdict = cms.error ? Verdict.INDETERMINATE : Verdict.INVALID;
      notes.push(
        cms.error
          ? `Verification could not complete: ${cms.error}`
          : 'Cryptographic signature verification failed.',
      );
    } else {
      report.verdict = Verdict.VALID;
      notes.push(
        'Signature is cryptographically valid. Certificate trust chain was NOT evaluated (v0.1 scope).',
      );
    }

    if (cms.digestAlgorithm && WEAK_DIGESTS.has(cms.digestAlgorithm)) {
      notes.push(
        `Digest algorithm ${cms.digestAlgorithm} is cryptographically weak (legacy signature format); integrity assurance is limited.`,
      );
    }
    if (cms.signerCertificate?.isExpiredNow) {
      notes.push('Signer certificate is expired as of now (may have been valid at signing time).');
    }
    if (report.coversEntireFile === false && (report.bytesAfterSignedRange ?? 0) > 0) {
      notes.push(
        `The file contains ${report.bytesAfterSignedRange} byte(s) after the signed range (later revisions exist).`,
      );
    }

    reports.push(report);
  }

  return reports;
}

/** Analyze document integrity (incremental updates, DocMDP) */
export function analyzeIntegrity(parsed: ParsedPdf): IntegrityReport {
  const notes: string[] = [];
  const signed = parsed.signatures.filter((s) => s.byteRange && s.contents?.length);

  const signaturesWithLaterChanges = signed
    .map((sig) => ({
      fieldName: sig.fieldName,
      bytesAfterSignedRange: bytesAfterRange(parsed.fileSize, sig.byteRange) ?? 0,
    }))
    .filter((s) => s.bytesAfterSignedRange > 0);

  const certificationSig = signed.find((s) => s.docMdpPermission !== null);
  let certification: IntegrityReport['certification'] = null;
  if (certificationSig?.docMdpPermission != null) {
    const permission = certificationSig.docMdpPermission;
    const laterChanges = (bytesAfterRange(parsed.fileSize, certificationSig.byteRange) ?? 0) > 0;
    certification = {
      fieldName: certificationSig.fieldName,
      permission,
      permissionDescription: DOCMDP_PERMISSIONS[permission] ?? `Unknown permission ${permission}`,
      violatedByLaterChanges: permission === 1 && laterChanges,
    };
    if (certification.violatedByLaterChanges) {
      notes.push(
        'DocMDP permission is 1 (no changes permitted) but the file was modified after certification.',
      );
    }
  }

  const last = signed[signed.length - 1];
  const lastCovers = last?.byteRange ? coversEntireFile(parsed.fileSize, last.byteRange) : null;

  if (parsed.signatures.length === 0) {
    notes.push('Document contains no signatures; integrity analysis is structural only.');
  }
  if (signaturesWithLaterChanges.length > 0 && lastCovers === false) {
    notes.push(
      'Bytes exist after the last signed range. Incremental updates after signing are legal in PDF ' +
        '(e.g., adding another signature or DSS), but the added content should be reviewed.',
    );
  }

  return {
    fileSize: parsed.fileSize,
    revisionCount: parsed.revisionCount,
    incrementalUpdateCount: Math.max(0, parsed.revisionCount - 1),
    signatureCount: signed.length,
    signaturesWithLaterChanges,
    certification,
    lastSignatureCoversFile: lastCovers,
    hasDss: parsed.hasDss,
    notes,
  };
}

function isPadesSubFilter(sig: SignatureField): boolean {
  return sig.subFilter === SUB_FILTER.ETSI_CADES_DETACHED;
}

/** Detect the PAdES baseline level of each signature */
export async function detectPadesLevels(parsed: ParsedPdf): Promise<PadesLevelReport[]> {
  const hasDocumentTimestamp = parsed.signatures.some(
    (s) => s.isDocumentTimestamp || s.subFilter === SUB_FILTER.ETSI_RFC3161,
  );

  const reports: PadesLevelReport[] = [];
  for (const sig of parsed.signatures) {
    if (sig.isDocumentTimestamp || sig.subFilter === SUB_FILTER.ETSI_RFC3161) continue;

    const notes: string[] = [];
    let hasSignatureTimestamp = false;

    if (sig.byteRange && sig.contents?.length) {
      try {
        const signedBytes = extractSignedBytes(parsed.bytes, sig.byteRange);
        const cms = await verifyCms(sig.contents, signedBytes);
        hasSignatureTimestamp = cms.hasSignatureTimestamp;
      } catch {
        notes.push('CMS payload could not be analyzed for timestamp attributes.');
      }
    }

    const isPades = isPadesSubFilter(sig);
    let level: PadesLevel | null = null;
    if (isPades) {
      if (hasSignatureTimestamp && parsed.hasDss && hasDocumentTimestamp) {
        level = PadesLevel.B_LTA;
      } else if (hasSignatureTimestamp && parsed.hasDss) {
        level = PadesLevel.B_LT;
      } else if (hasSignatureTimestamp) {
        level = PadesLevel.B_T;
      } else {
        level = PadesLevel.B_B;
      }
      notes.push(
        `Structural detection: ${level}. Content-level validation of LTV data is v0.2 scope.`,
      );
    } else if (sig.subFilter === SUB_FILTER.ADBE_PKCS7_DETACHED) {
      notes.push(
        'Legacy ISO 32000-1 signature (adbe.pkcs7.detached) — not a PAdES baseline signature.',
      );
    } else {
      notes.push(`SubFilter "${sig.subFilter ?? '(none)'}" is not a PAdES signature.`);
    }

    reports.push({
      fieldName: sig.fieldName,
      subFilter: sig.subFilter,
      isPades,
      level,
      evidence: {
        hasSignatureTimestamp,
        hasDss: parsed.hasDss,
        hasVri: parsed.hasVri,
        hasDocumentTimestamp,
      },
      notes,
    });
  }
  return reports;
}
