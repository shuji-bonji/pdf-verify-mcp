/**
 * Verification orchestration: combines pdf-parser and cms-verifier
 * into the reports returned by the MCP tools.
 */

import {
  DOCMDP_PERMISSIONS,
  PadesLevel,
  RevocationMode,
  RevocationStatus,
  SUB_FILTER,
  TrustStatus,
  Verdict,
  WEAK_DIGESTS,
} from '../constants.js';
import type {
  IntegrityReport,
  PadesLevelReport,
  ParsedPdf,
  SignatureField,
  SignatureVerificationReport,
  TrustResult,
} from '../types.js';
import { extractCmsArtifacts, verifyCms, verifyTimestampImprint } from './cms-verifier.js';
import { coversEntireFile, extractSignedBytes } from './pdf-parser.js';
import {
  checkRevocation,
  evaluateTrust,
  fetchMissingIssuers,
  parseCertificates,
  parseCrls,
  parseOcspResponses,
} from './revocation.js';
import { loadTrustAnchors } from './trust-store.js';

function bytesAfterRange(fileSize: number, byteRange: number[] | null): number | null {
  if (byteRange?.length !== 4) return null;
  return fileSize - (byteRange[2] + byteRange[3]);
}

export interface VerifyOptions {
  /** PEM/DER file paths for trust anchors (merged with PDF_VERIFY_TRUST_ANCHORS) */
  trustAnchorPaths?: string[];
  /** Revocation checking mode (default: embedded) */
  revocationMode?: RevocationMode;
}

// Note: the `password` option is handled at parse time (see parsePdf),
// so it is not part of VerifyOptions.

const NOT_EVALUATED_TRUST: TrustResult = {
  status: TrustStatus.NOT_EVALUATED,
  detail: null,
  certificatePath: null,
};

/** Verify all signatures in the document */
export async function verifySignatures(
  parsed: ParsedPdf,
  options: VerifyOptions = {},
): Promise<SignatureVerificationReport[]> {
  const reports: SignatureVerificationReport[] = [];
  const revocationMode = options.revocationMode ?? RevocationMode.EMBEDDED;
  const trustStore = await loadTrustAnchors(options.trustAnchorPaths ?? []);

  // DSS materials are shared by all signatures in the document
  const dssCerts = parseCertificates(parsed.dss?.certs ?? []);
  const dssOcsps = parseOcspResponses(parsed.dss?.ocsps ?? []);
  const dssCrls = parseCrls(parsed.dss?.crls ?? []);

  for (const sig of parsed.signatures) {
    const notes: string[] = [];
    const report: SignatureVerificationReport = {
      fieldName: sig.fieldName,
      subFilter: sig.subFilter,
      verdict: Verdict.INDETERMINATE,
      trust: { ...NOT_EVALUATED_TRUST },
      revocation: null,
      coversEntireFile: null,
      bytesAfterSignedRange: null,
      cms: null,
      signingTimeDictionary: sig.signingTimeDictionary,
      reason: sig.reason,
      location: sig.location,
      isDocumentTimestamp: sig.isDocumentTimestamp,
      notes,
    };

    for (const err of trustStore.errors) {
      notes.push(`Trust anchor load error: ${err}`);
    }

    if (parsed.isEncrypted && parsed.decrypted) {
      notes.push('Document is encrypted; decryption succeeded and string metadata was recovered.');
    } else if (parsed.isEncrypted) {
      notes.push(
        'Document is encrypted and could not be decrypted (wrong password or unsupported handler); string metadata was omitted. Cryptographic verification is unaffected. Pass "password" if this is a reader-password PDF.',
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
        notes.push('Document timestamp verified.');
      } else {
        notes.push('Document timestamp could not be fully verified.');
      }

      // v0.4: evaluate the TSA chain of a document timestamp against anchors
      const tsaArtifacts = extractCmsArtifacts(sig.contents);
      if (tsaArtifacts?.signerCert && trustStore.certificates.length > 0) {
        report.trust = await evaluateTrust({
          signerCert: tsaArtifacts.signerCert,
          availableCerts: [...tsaArtifacts.certificates, ...dssCerts],
          trustAnchors: trustStore.certificates,
          checkDate: new Date(),
          crls: dssCrls,
          ocsps: dssOcsps,
        });
      }
      reports.push(report);
      continue;
    }

    if (
      sig.subFilter !== SUB_FILTER.ADBE_PKCS7_DETACHED &&
      sig.subFilter !== SUB_FILTER.ETSI_CADES_DETACHED
    ) {
      notes.push(
        `SubFilter "${sig.subFilter ?? '(none)'}" is not supported ` +
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
      notes.push('Signature is cryptographically valid.');
    }

    // v0.2: trust chain evaluation and revocation checking
    const artifacts = extractCmsArtifacts(sig.contents);
    if (artifacts?.signerCert) {
      const availableCerts = [...artifacts.certificates, ...dssCerts];
      const embeddedOcsps = dssOcsps;
      const embeddedCrls = [...artifacts.crls, ...dssCrls];
      const checkDate =
        artifacts.signingTime ??
        (cms.signatureTimestamp?.genTime ? new Date(cms.signatureTimestamp.genTime) : new Date());

      // v0.4: complete the chain via AIA caIssuers (online mode only)
      if (revocationMode === RevocationMode.ONLINE) {
        const fetchedIssuers = await fetchMissingIssuers(artifacts.signerCert, availableCerts);
        if (fetchedIssuers.length > 0) {
          availableCerts.push(...fetchedIssuers);
          notes.push(
            `Fetched ${fetchedIssuers.length} issuer certificate(s) via AIA caIssuers to complete the chain.`,
          );
        }
      }

      report.trust = await evaluateTrust({
        signerCert: artifacts.signerCert,
        availableCerts,
        trustAnchors: trustStore.certificates,
        checkDate,
        crls: embeddedCrls,
        ocsps: embeddedOcsps,
      });
      if (report.trust.status === TrustStatus.UNTRUSTED) {
        notes.push(`Trust evaluation failed: ${report.trust.detail}`);
      }

      if (revocationMode !== RevocationMode.NONE) {
        report.revocation = await checkRevocation({
          signerCert: artifacts.signerCert,
          availableCerts,
          embeddedOcsps,
          embeddedCrls,
          online: revocationMode === RevocationMode.ONLINE,
        });
        if (report.revocation.status === RevocationStatus.REVOKED) {
          report.verdict = Verdict.INVALID;
          notes.push(
            `Signer certificate is REVOKED (${report.revocation.source}): ${report.revocation.detail}`,
          );
        }
      }

      if (cms.signatureTimestamp) {
        if (cms.signatureTimestamp.imprintMatches === false) {
          notes.push('Signature timestamp messageImprint does NOT match the signature value.');
        } else if (cms.signatureTimestamp.signatureVerified) {
          notes.push(
            `Signature timestamp verified (TSA: ${cms.signatureTimestamp.tsaSubject ?? 'unknown'}, genTime: ${cms.signatureTimestamp.genTime ?? 'unknown'}).`,
          );
        }

        // v0.4: evaluate the TSA chain against trust anchors
        if (artifacts.signatureTimestampToken && trustStore.certificates.length > 0) {
          const tsaArtifacts = extractCmsArtifacts(artifacts.signatureTimestampToken);
          if (tsaArtifacts?.signerCert) {
            cms.signatureTimestamp.tsaTrust = await evaluateTrust({
              signerCert: tsaArtifacts.signerCert,
              availableCerts: [...tsaArtifacts.certificates, ...availableCerts],
              trustAnchors: trustStore.certificates,
              checkDate: cms.signatureTimestamp.genTime
                ? new Date(cms.signatureTimestamp.genTime)
                : checkDate,
              crls: embeddedCrls,
              ocsps: embeddedOcsps,
            });
            if (cms.signatureTimestamp.tsaTrust.status === TrustStatus.UNTRUSTED) {
              notes.push(`TSA chain evaluation failed: ${cms.signatureTimestamp.tsaTrust.detail}`);
            }
          }
        }
      }
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
    // ISO 32000-2 §12.8.2.2: P=1 means the document shall be final, "with the
    // exception of subsequent DSS (12.8.4.3) and/or document timestamp (12.8.5)
    // incremental updates". Detect that exception structurally: a DSS is
    // present and/or a document timestamp signature covers bytes beyond the
    // certified range (i.e., was added after certification).
    const certRangeEnd =
      certificationSig.byteRange?.length === 4
        ? certificationSig.byteRange[2] + certificationSig.byteRange[3]
        : null;
    const laterDts = parsed.signatures.some(
      (s) =>
        (s.isDocumentTimestamp || s.subFilter === SUB_FILTER.ETSI_RFC3161) &&
        certRangeEnd !== null &&
        s.byteRange?.length === 4 &&
        s.byteRange[2] + s.byteRange[3] > certRangeEnd,
    );
    const laterChangesAppearLtvOnly = laterChanges && (parsed.hasDss || laterDts);
    certification = {
      fieldName: certificationSig.fieldName,
      permission,
      permissionDescription: DOCMDP_PERMISSIONS[permission] ?? `Unknown permission ${permission}`,
      violatedByLaterChanges: permission === 1 && laterChanges && !laterChangesAppearLtvOnly,
      laterChangesAppearLtvOnly,
    };
    if (certification.violatedByLaterChanges) {
      notes.push(
        'DocMDP permission is 1 (no changes permitted) but the file was modified after certification. ' +
          'No DSS or document timestamp was found in the later updates, so the ISO 32000-2 §12.8.2.2 ' +
          'exception (DSS/document-timestamp incremental updates) does not apply.',
      );
    } else if (permission === 1 && laterChanges) {
      notes.push(
        'The file was modified after certification (P=1), but a DSS and/or document timestamp is present — ' +
          'ISO 32000-2 §12.8.2.2 permits DSS/document-timestamp incremental updates even when P=1. ' +
          'Object-level confirmation that the later updates contain nothing else is not performed here.',
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

  // DSS materials for content-level LTV validation
  const dssCerts = parseCertificates(parsed.dss?.certs ?? []);
  const dssOcsps = parseOcspResponses(parsed.dss?.ocsps ?? []);
  const dssCrls = parseCrls(parsed.dss?.crls ?? []);

  const reports: PadesLevelReport[] = [];
  for (const sig of parsed.signatures) {
    if (sig.isDocumentTimestamp || sig.subFilter === SUB_FILTER.ETSI_RFC3161) continue;

    const notes: string[] = [];
    let hasSignatureTimestamp = false;
    let ltv: PadesLevelReport['ltv'] = null;

    if (sig.byteRange && sig.contents?.length) {
      try {
        const signedBytes = extractSignedBytes(parsed.bytes, sig.byteRange);
        const cms = await verifyCms(sig.contents, signedBytes);
        hasSignatureTimestamp = cms.hasSignatureTimestamp;
      } catch {
        notes.push('CMS payload could not be analyzed for timestamp attributes.');
      }

      // Content-level LTV check: does DSS revocation data cover the signer?
      if (parsed.hasDss) {
        let coversSigner: boolean | null = null;
        const artifacts = extractCmsArtifacts(sig.contents);
        if (artifacts?.signerCert) {
          const revocation = await checkRevocation({
            signerCert: artifacts.signerCert,
            availableCerts: [...artifacts.certificates, ...dssCerts],
            embeddedOcsps: dssOcsps,
            embeddedCrls: [...artifacts.crls, ...dssCrls],
            online: false,
          });
          coversSigner = revocation.source !== null;
        }
        ltv = {
          dssCertCount: dssCerts.length,
          dssOcspCount: dssOcsps.length,
          dssCrlCount: dssCrls.length,
          revocationDataCoversSigner: coversSigner,
        };
      }
    }

    const isPades = isPadesSubFilter(sig);
    let level: PadesLevel | null = null;
    if (isPades) {
      const hasUsableLtv = parsed.hasDss && ltv?.revocationDataCoversSigner === true;
      if (hasSignatureTimestamp && hasUsableLtv && hasDocumentTimestamp) {
        level = PadesLevel.B_LTA;
      } else if (hasSignatureTimestamp && hasUsableLtv) {
        level = PadesLevel.B_LT;
      } else if (hasSignatureTimestamp) {
        level = PadesLevel.B_T;
        if (parsed.hasDss && ltv?.revocationDataCoversSigner === false) {
          notes.push(
            'DSS is present but its revocation data does not cover the signer certificate — level capped at B-T.',
          );
        }
      } else {
        level = PadesLevel.B_B;
      }
      notes.push(`Detected level: ${level} (content-validated LTV data).`);
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
      ltv,
      notes,
    });
  }
  return reports;
}
