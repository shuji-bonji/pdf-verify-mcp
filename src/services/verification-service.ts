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
  DocMdpAssessment,
  DocMdpChangeClass,
  IntegrityReport,
  PadesLevelReport,
  ParsedPdf,
  RevisionChainCoverage,
  RevisionChainEnd,
  RevisionCountAgreement,
  RevisionCountCause,
  RevisionObjectChange,
  RevisionSummary,
  SignatureField,
  SignatureVerificationReport,
  TrustResult,
} from '../types.js';
import { extractCmsArtifacts, verifyCms, verifyTimestampImprint } from './cms-verifier.js';
import { coversEntireFile, extractSignedBytes } from './pdf-parser.js';
import { diffRevisions } from './revision-diff.js';
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
      } else if (imprintMatches === true && !cms.signatureVerified && !cms.error) {
        // Same rule as ordinary signatures: a signature that was computed and
        // came back false is a disproof (INVALID); only "could not measure"
        // stays INDETERMINATE.
        report.verdict = Verdict.INVALID;
        notes.push(
          'Timestamp messageImprint matches, but the TSA signature failed cryptographic verification.',
        );
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

/**
 * What each DocMDP permission value allows, as classes of change.
 *
 * ISO 32000-2 Table 257 (12.8.2.2.2):
 *   1 — "No changes to the document shall be permitted"
 *   2 — "Permitted changes shall be filling in forms, instantiating page
 *        templates, and signing; other changes shall invalidate the signature."
 *   3 — "the same as for 2, as well as annotation creation, deletion, and
 *        modification; other changes shall invalidate the signature."
 *
 * `housekeeping` and `bookkeeping` are allowed at every value: they are what a
 * permitted change necessarily drags along (the page whose /Annots grew, the
 * /Info dictionary's /ModDate, the cross-reference stream). Measured on a
 * lawful P=3 annotation addition: catalog, page, /Info and XMP all move.
 * Counting them as changes in their own right would make every certified
 * document violate, which cannot be the reading.
 *
 * ⚠️ P=1 is NOT expressed here: "any change" is judged from bytes, with the
 * §12.8.2.2 DSS/document-timestamp exception. Keeping it out of the table
 * avoids implying that P=1 tolerates housekeeping.
 */
const DOCMDP_PERMITTED_CLASSES: Readonly<Record<number, ReadonlySet<DocMdpChangeClass>>> = {
  2: new Set<DocMdpChangeClass>(['form-fill', 'signature', 'housekeeping', 'bookkeeping']),
  3: new Set<DocMdpChangeClass>([
    'form-fill',
    'signature',
    'annotation',
    'housekeeping',
    'bookkeeping',
  ]),
};

/** Objects written by revisions appended after `rangeEnd`. */
function changesAfter(
  diff: { revisions: RevisionSummary[] } | null,
  rangeEnd: number | null,
): RevisionObjectChange[] {
  if (!diff || rangeEnd === null) return [];
  const out: RevisionObjectChange[] = [];
  for (const revision of diff.revisions) {
    if (revision.xrefOffset < rangeEnd || !revision.changes) continue;
    out.push(...revision.changes);
  }
  return out;
}

/**
 * Decide whether the changes made after certification stay inside what P allows.
 *
 * 🔴 Before 0.14.0 this was one expression — `permission === 1 && laterChanges` —
 * so **P=2 and P=3 could never be violated**, whatever was appended. A P=2
 * document that gained an annotation (which Table 257 grants only from P=3)
 * read as clean, and `POL-REVIEW-DOCMDP-VIOLATION` never fired, so the 4-value
 * verdict did not rise to human_review_required either. It failed open.
 *
 * The fix is not a stricter threshold but a different question: **what kind of
 * change was it**, which the object-level diff already answers.
 */
function assessDocMdp(input: {
  permission: number;
  laterChanges: boolean;
  laterChangesAppearLtvOnly: boolean;
  changes: RevisionObjectChange[];
  diffAvailable: boolean;
  chainIncomplete: boolean;
}): { assessment: DocMdpAssessment; reason: string } {
  const { permission, laterChanges, laterChangesAppearLtvOnly, changes } = input;

  if (!laterChanges) {
    return { assessment: 'permitted', reason: 'nothing was appended after the certified range' };
  }
  if (permission === 1) {
    return laterChangesAppearLtvOnly
      ? {
          assessment: 'permitted',
          reason:
            'a DSS and/or document timestamp is present, the ISO 32000-2 §12.8.2.2 exception for P=1',
        }
      : {
          assessment: 'violated',
          reason:
            'P=1 permits no changes, and the later updates are not DSS/document-timestamp only',
        };
  }

  const permitted = DOCMDP_PERMITTED_CLASSES[permission];
  if (!permitted) {
    return {
      assessment: 'indeterminate',
      reason: `permission value ${permission} is not one of the values ISO 32000-2 Table 257 defines (1, 2, 3)`,
    };
  }
  // 🔴 Bytes were appended, but the chain could not be read — "could not tell",
  // not "fine". [[revision-diff-lies-linearized-and-full-save]]: not being able
  // to walk the chain is not evidence that nothing changed.
  if (!input.diffAvailable) {
    return {
      assessment: 'indeterminate',
      reason: 'bytes were appended but the cross-reference chain could not be walked',
    };
  }
  if (input.chainIncomplete) {
    return {
      assessment: 'indeterminate',
      reason: 'the revision chain is incomplete, so the later changes are not fully represented',
    };
  }
  if (changes.length === 0) {
    return {
      assessment: 'indeterminate',
      reason: 'bytes were appended after the certified range but no changed object could be listed',
    };
  }

  const offending = changes.filter(
    (c) => c.changeClass !== 'unknown' && !permitted.has(c.changeClass),
  );
  if (offending.length > 0) {
    const shown = offending
      .slice(0, 3)
      .map((c) => `obj ${c.objectNumber} (${c.role ?? c.changeClass})`)
      .join(', ');
    return {
      assessment: 'violated',
      reason: `${offending.length} object(s) outside what P=${permission} permits: ${shown}`,
    };
  }
  const unknown = changes.filter((c) => c.changeClass === 'unknown');
  if (unknown.length > 0) {
    return {
      assessment: 'indeterminate',
      reason:
        `${unknown.length} changed object(s) could not be typed (e.g. objects inside an object ` +
        'stream), so whether they stay inside P is not determined',
    };
  }
  return {
    assessment: 'permitted',
    reason: `every later change is of a kind P=${permission} permits`,
  };
}

/**
 * Analyze document integrity (incremental updates, DocMDP).
 *
 * Async because the object-level diff reads the cross-reference chain through
 * normativepdf, whose section reader is async — a cross-reference stream has to
 * be inflated before its entries exist (ISO 32000-1 §7.5.8).
 */
export async function analyzeIntegrity(parsed: ParsedPdf): Promise<IntegrityReport> {
  const notes: string[] = [];
  const signed = parsed.signatures.filter((s) => s.byteRange && s.contents?.length);

  const signaturesWithLaterChanges = signed
    .map((sig) => ({
      fieldName: sig.fieldName,
      bytesAfterSignedRange: bytesAfterRange(parsed.fileSize, sig.byteRange) ?? 0,
    }))
    .filter((s) => s.bytesAfterSignedRange > 0);

  // Issue #8 — which objects each incremental update wrote. Observation only:
  // it refines "N bytes were appended" into "these objects were written".
  // 🔴 Computed **before** the DocMDP assessment: P=2/P=3 cannot be judged from
  // byte counts alone (that was the bug — see `assessDocMdp`).
  const diff = await diffRevisions({
    bytes: parsed.bytes,
    signedRanges: signed.flatMap((sig) => {
      const range = sig.byteRange;
      return range?.length === 4
        ? [{ fieldName: sig.fieldName, endOffset: range[2] + range[3] }]
        : [];
    }),
  });

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
    const { assessment, reason } = assessDocMdp({
      permission,
      laterChanges,
      laterChangesAppearLtvOnly,
      changes: changesAfter(diff, certRangeEnd),
      diffAvailable: diff !== null,
      chainIncomplete: diff?.truncated === true || diff?.newestSectionUnreadable === true,
    });
    certification = {
      fieldName: certificationSig.fieldName,
      permission,
      permissionDescription: DOCMDP_PERMISSIONS[permission] ?? `Unknown permission ${permission}`,
      violatedByLaterChanges: assessment === 'violated',
      violationAssessment: assessment,
      assessmentReason: reason,
      laterChangesAppearLtvOnly,
    };
    if (assessment === 'violated') {
      notes.push(
        `DocMDP permission is ${permission} (${DOCMDP_PERMISSIONS[permission] ?? 'unknown'}) and the ` +
          `file was changed after certification in a way that value does not permit: ${reason}. ` +
          'ISO 32000-2 Table 257 states that other changes "shall invalidate the signature".',
      );
    } else if (assessment === 'indeterminate') {
      notes.push(
        `DocMDP permission is ${permission}, but whether the later changes stay inside it could NOT be ` +
          `determined: ${reason}. This is not a pass — read violationAssessment, not ` +
          'violatedByLaterChanges (which is false here only because nothing could be disproved).',
      );
    } else if (permission === 1 && laterChanges && laterChangesAppearLtvOnly) {
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

  const lastSignedEnd =
    last?.byteRange?.length === 4 ? last.byteRange[2] + last.byteRange[3] : null;
  const objectChangesAfterLastSignature = changesAfter(diff, lastSignedEnd);

  if (diff === null && parsed.revisionCount > 1) {
    notes.push(
      'The cross-reference chain could not be walked, so no object-level revision diff is ' +
        'reported. Absence of a diff here means "not determined", not "nothing changed".',
    );
  } else if (diff?.truncated) {
    notes.push(
      'The cross-reference chain ended before reaching the original revision (damaged or ' +
        'cyclic /Prev). The revisions listed are the ones that could be followed.',
    );
  }
  if (diff?.newestSectionUnreadable) {
    notes.push(
      'The last "startxref" does not point at a parseable cross-reference section, so the chain ' +
        'was entered from an older one. Whatever was appended last is therefore NOT represented ' +
        'in the revision list below.',
    );
  }
  if (diff?.linearized) {
    notes.push(
      'The file is linearised (ISO 32000-2 Annex F): its first-page and main cross-reference ' +
        'sections belong to one save and were counted as one revision, not as an incremental update.',
    );
  }
  if (diff && diff.revisions.length !== parsed.revisionCount) {
    // 🔴 V-F7: this used to end with "the two counts differ legitimately in
    // linearised files and in files carrying a cross-reference section no chain
    // points at" — both causes listed, neither claimed. The walker knows which
    // one applies, so the sentence names it, and only says "not determined"
    // when nothing read from the file accounts for the difference.
    const counted =
      `The cross-reference chain yields ${diff.revisions.length} revision(s) while ` +
      `${parsed.revisionCount} "startxref" keyword(s) are present.`;
    const because: string[] = [];
    if (diff.linearized) {
      because.push("the file's linearisation (two cross-reference sections for one save)");
    }
    if (diff.truncated || diff.newestSectionUnreadable) {
      because.push('the chain not being followed in full (see revisionChain)');
    }
    notes.push(
      because.length > 0
        ? `${counted} What accounts for the difference: ${because.join('; ')}.`
        : `${counted} Nothing read from the file accounts for the difference: the chain was walked ` +
            'in full and the file is not linearised. The two counts measure different things — every ' +
            '"startxref" keyword in the byte stream against the cross-reference sections the chain ' +
            'reached — and in this file they do not line up.',
    );
  }
  const truncatedRevisions = diff?.revisions.filter((r) => r.changesTruncated) ?? [];
  if (truncatedRevisions.length > 0) {
    notes.push(
      `Revision(s) ${truncatedRevisions.map((r) => r.index).join(', ')} changed more objects than are ` +
        'listed (see changeCount). A revision that rewrites nearly every object is a full save rather ' +
        'than an incremental update.',
    );
  }
  const contentChangesAfterSigning = objectChangesAfterLastSignature.filter((c) => !c.bookkeeping);
  if (contentChangesAfterSigning.length > 0) {
    notes.push(
      `${contentChangesAfterSigning.length} object(s) other than cross-reference/object-stream ` +
        'bookkeeping were written after the last signed range. Incremental updates are legal in PDF; ' +
        'this identifies what to review, not that the document was tampered with.',
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
    revisions: diff?.revisions ?? null,
    revisionChain: chainCoverage(diff),
    revisionCountAgreement: reconcileRevisionCount(diff, parsed.revisionCount),
    objectChangesAfterLastSignature,
    notes,
  };
}

/**
 * Turn the walker's two flags into the one thing a caller branches on.
 *
 * 🔴 **Derived in exactly one place.** The three cases used to be reconstructed
 * by whoever read the report — by matching English sentences in `notes`, since
 * there was no field at all (V-F6). Anything that recomputes "is this the whole
 * history" somewhere else is a second source of truth for the same fact.
 *
 * `null` in means the chain could not be entered at all: nothing was read, so
 * **both** ends are absent. Saying `missing: []` there would read as "nothing
 * is missing", which is the exact misreading this field exists to remove.
 */
function chainCoverage(
  diff: { truncated: boolean; newestSectionUnreadable: boolean } | null,
): RevisionChainCoverage {
  if (!diff) return { status: 'unwalkable', missing: ['oldest', 'newest'] };
  const missing: RevisionChainEnd[] = [];
  // Ordered oldest-end first, matching the order `revisions` is listed in.
  if (diff.truncated) missing.push('oldest');
  if (diff.newestSectionUnreadable) missing.push('newest');
  return { status: missing.length === 0 ? 'complete' : 'partial', missing };
}

/**
 * Reconcile the two revision counts the report carries (V-F7).
 *
 * 🔴 **Derived in exactly one place**, for the reason `chainCoverage` is: the
 * alternative is every caller recombining `revisionCount`, `revisions.length`
 * and a linearisation flag, and each of them being a second source of truth for
 * the same fact. `pdf-trust`'s guidance had already given up on the numbers and
 * told readers to read the prose instead.
 *
 * `causes` states what was read from the file, so it can be non-empty while
 * `status` is `agree` — a fact about the file does not stop being true because
 * two numbers happen to land on the same value. `null` in means no section was
 * read at all: nothing is listed, which `chain-incomplete` accounts for.
 */
function reconcileRevisionCount(
  diff: {
    revisions: unknown[];
    linearized: boolean;
    truncated: boolean;
    newestSectionUnreadable: boolean;
  } | null,
  startxrefCount: number,
): RevisionCountAgreement {
  const causes: RevisionCountCause[] = [];
  if (diff?.linearized) causes.push('linearised');
  if (!diff || diff.truncated || diff.newestSectionUnreadable) causes.push('chain-incomplete');
  const listed = diff?.revisions.length ?? 0;
  if (listed === startxrefCount) return { status: 'agree', causes };
  return { status: causes.length > 0 ? 'accounted' : 'unaccounted', causes };
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
      // T3: 規範（ETSI EN 319 142）を手元に持たないので、断定形で書かない。
      // 「構造がこの形に一致する」という観測であることを出力自体に持たせる
      // （`specs/09 §2`「T3 における観測と判定の分界」/ Issue #9）。
      notes.push(
        `The structure matches PAdES ${level} (signature timestamp and DSS coverage were checked in the file). ` +
          'This is an observation of structure, not a conformance verdict — ETSI EN 319 142 is not in this ' +
          'family\'s corpus, so "conforms to PAdES" cannot be claimed from this result.',
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
      // PAdES は常に T3（規範なし・第三者検証器なし = 構造の観測にとどまる）
      normativeBasis: 'T3',
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
