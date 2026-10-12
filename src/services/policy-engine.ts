/**
 * Deterministic trust-policy engine (Issue #4, v0.7.0).
 *
 * "The judge is code, the narrative is the LLM": pdf-trust previously asked
 * the LLM to fold verification facts into a 4-value recommendation, which is
 * subject to interpretation drift on edge cases, over-fitting to document
 * content, and silent model updates. This engine encodes that judgment table
 * (pdf-trust SKILL.md + profile references) as ordered rules over the
 * deterministic facts the other tools already produce. Same facts + same
 * profile = same verdict, every time.
 *
 * The LLM's role shrinks to explaining WHY the fired rules fired and what to
 * do about it — it has no say in the verdict.
 */

import { PadesLevel, RevocationStatus, TrustStatus, Verdict, WEAK_DIGESTS } from '../constants.js';
import type {
  ContentInventory,
  IntegrityReport,
  PadesLevelReport,
  SignatureVerificationReport,
} from '../types.js';
import type { ConformanceValidationReport } from './conformance-validation.js';
import { isXmpSchemaClause } from './xmp-schemas.js';

export type PolicyVerdict =
  | 'trust_and_use'
  | 'use_with_caution'
  | 'human_review_required'
  | 'reject';

export type PolicyProfileId =
  | 'general'
  | 'contract'
  | 'financial'
  | 'legal'
  | 'medical'
  | 'government';

const SEVERITY: Record<PolicyVerdict, number> = {
  trust_and_use: 0,
  use_with_caution: 1,
  human_review_required: 2,
  reject: 3,
};

export interface PolicyProfile {
  id: PolicyProfileId;
  description: string;
  /** Unsigned document → human_review_required (contract, medical) */
  requireSignature: boolean;
  /** use_with_caution results are escalated to human_review_required (medical) */
  escalateCautionToReview: boolean;
  /** Long-term preservation checks always run (financial, government) */
  longTermChecks: boolean;
  /** PAdES level below this adds an advisory (never changes the verdict) */
  recommendedMinPadesLevel: PadesLevel | null;
}

export const POLICY_PROFILES: Record<PolicyProfileId, PolicyProfile> = {
  general: {
    id: 'general',
    description: 'Default thresholds (pdf-trust SKILL.md judgment table)',
    requireSignature: false,
    escalateCautionToReview: false,
    longTermChecks: false,
    recommendedMinPadesLevel: null,
  },
  contract: {
    id: 'contract',
    description: 'Contracts/NDAs — signer identity carries the most weight',
    requireSignature: true,
    escalateCautionToReview: false,
    longTermChecks: false,
    recommendedMinPadesLevel: PadesLevel.B_T,
  },
  financial: {
    id: 'financial',
    description: 'Invoices/filings — verifiability until the end of retention',
    requireSignature: false,
    escalateCautionToReview: false,
    longTermChecks: true,
    recommendedMinPadesLevel: PadesLevel.B_LT,
  },
  legal: {
    id: 'legal',
    description: 'Litigation/legal documents — full change history matters',
    requireSignature: false,
    escalateCautionToReview: false,
    longTermChecks: false,
    recommendedMinPadesLevel: PadesLevel.B_T,
  },
  medical: {
    id: 'medical',
    description: 'Clinical documents — most conservative profile',
    requireSignature: true,
    escalateCautionToReview: true,
    longTermChecks: false,
    recommendedMinPadesLevel: null,
  },
  government: {
    id: 'government',
    description: 'Government documents — unsigned is common, preservation matters',
    requireSignature: false,
    escalateCautionToReview: false,
    longTermChecks: true,
    recommendedMinPadesLevel: PadesLevel.B_LTA,
  },
};

export interface PolicyFacts {
  signatures: SignatureVerificationReport[];
  integrity: IntegrityReport;
  pades: PadesLevelReport[];
  /** null when the profile does not run long-term checks or the check errored */
  conformance: ConformanceValidationReport | null;
  /**
   * What the document carries that acts or is unfinished (#20, #21). `null` when the
   * inventory could not be taken — then the rules that read it stay silent and an advisory
   * says so, because "not counted" is not "0".
   */
  content?: ContentInventory | null;
}

export interface FiredRule {
  ruleId: string;
  verdict: PolicyVerdict;
  reason: string;
}

export interface PolicyEvaluation {
  profile: PolicyProfileId;
  verdict: PolicyVerdict;
  firedRules: FiredRule[];
  /** Recommendations that do not affect the verdict */
  advisories: string[];
  notes: string[];
}

/** Signatures that carry content (exclude document timestamps) */
function contentSignatures(facts: PolicyFacts): SignatureVerificationReport[] {
  return facts.signatures.filter((s) => !s.isDocumentTimestamp);
}

interface RuleDef {
  ruleId: string;
  verdict: PolicyVerdict;
  applies: (facts: PolicyFacts, profile: PolicyProfile) => string | null;
}

const label = (s: SignatureVerificationReport): string => s.fieldName ?? '(unnamed)';

/**
 * Ordered rule set. Every rule is evaluated; the verdict is the highest
 * severity among those that fire. When none fires, the positive gate for
 * trust_and_use has been satisfied by construction (any missing evidence
 * fires one of the caution rules).
 */
const RULES: RuleDef[] = [
  {
    ruleId: 'POL-REJECT-INVALID',
    verdict: 'reject',
    applies: (f) => {
      const bad = contentSignatures(f).filter((s) => s.verdict === Verdict.INVALID);
      return bad.length > 0
        ? `Signature(s) cryptographically invalid (digest mismatch or signature verification failure): ${bad.map(label).join(', ')}`
        : null;
    },
  },
  {
    ruleId: 'POL-REJECT-REVOKED',
    verdict: 'reject',
    applies: (f) => {
      const revoked = contentSignatures(f).filter(
        (s) => s.revocation?.status === RevocationStatus.REVOKED,
      );
      return revoked.length > 0
        ? `Signer certificate is revoked: ${revoked.map(label).join(', ')}`
        : null;
    },
  },
  {
    ruleId: 'POL-REVIEW-INDETERMINATE',
    verdict: 'human_review_required',
    applies: (f) => {
      const ind = contentSignatures(f).filter((s) => s.verdict === Verdict.INDETERMINATE);
      return ind.length > 0
        ? `Signature verification could not complete (unsupported format, parse failure, or undecryptable content): ${ind.map(label).join(', ')}`
        : null;
    },
  },
  {
    ruleId: 'POL-REVIEW-DOCMDP-VIOLATION',
    verdict: 'human_review_required',
    applies: (f) =>
      f.integrity.certification?.violationAssessment === 'violated'
        ? `DocMDP permission ${f.integrity.certification.permission} violated by changes after certification: ${f.integrity.certification.assessmentReason}`
        : null,
  },
  {
    // 🔴 "Could not tell" must not read as "fine". Before 0.14.0 the assessment
    // was a boolean, so a document whose later changes could not be classified
    // was indistinguishable from one that was verified clean — and the verdict
    // stayed at use_with_caution. Reviewing a handful of unreadable files is
    // the cheaper error.
    ruleId: 'POL-REVIEW-DOCMDP-INDETERMINATE',
    verdict: 'human_review_required',
    applies: (f) =>
      f.integrity.certification?.violationAssessment === 'indeterminate'
        ? `DocMDP permission ${f.integrity.certification.permission}: whether the later changes stay inside it could not be determined (${f.integrity.certification.assessmentReason})`
        : null,
  },
  {
    ruleId: 'POL-REVIEW-UNSIGNED-REQUIRED',
    verdict: 'human_review_required',
    applies: (f, p) =>
      p.requireSignature && contentSignatures(f).length === 0
        ? `Profile "${p.id}" requires a signature; the document has none (an image of a signature is not an electronic signature)`
        : null,
  },
  {
    ruleId: 'POL-CAUTION-UNSIGNED',
    verdict: 'use_with_caution',
    applies: (f, p) =>
      !p.requireSignature && contentSignatures(f).length === 0
        ? 'No signatures: authenticity has no technical backing (verify provenance by other means)'
        : null,
  },
  {
    ruleId: 'POL-CAUTION-TRUST-NOT-EVALUATED',
    verdict: 'use_with_caution',
    applies: (f) => {
      const ne = contentSignatures(f).filter(
        (s) => s.verdict === Verdict.VALID && s.trust.status === TrustStatus.NOT_EVALUATED,
      );
      return ne.length > 0
        ? `Cryptographic integrity confirmed but signer identity NOT evaluated (no trust anchors): ${ne.map(label).join(', ')}`
        : null;
    },
  },
  {
    ruleId: 'POL-CAUTION-TRUST-UNTRUSTED',
    verdict: 'use_with_caution',
    applies: (f) => {
      const ut = contentSignatures(f).filter(
        (s) => s.verdict === Verdict.VALID && s.trust.status === TrustStatus.UNTRUSTED,
      );
      return ut.length > 0
        ? `Certificate chain does not reach a trust anchor (missing intermediate CA or different anchor): ${ut.map(label).join(', ')}`
        : null;
    },
  },
  {
    ruleId: 'POL-CAUTION-REVOCATION-UNKNOWN',
    verdict: 'use_with_caution',
    applies: (f) => {
      const unknown = contentSignatures(f).filter(
        (s) =>
          s.verdict === Verdict.VALID &&
          (s.revocation === null ||
            s.revocation.status === RevocationStatus.UNKNOWN ||
            s.revocation.status === RevocationStatus.NOT_CHECKED),
      );
      return unknown.length > 0
        ? `Revocation status could not be confirmed ("not revoked" cannot be claimed): ${unknown.map(label).join(', ')}`
        : null;
    },
  },
  {
    // v0.27.0 (#13): a timestamp proves the signature predates the revocation,
    // so the signature stands — but the certificate is revoked now, which a
    // reader acting on the document today should know.
    ruleId: 'POL-CAUTION-REVOKED-AFTER-SIGNING',
    verdict: 'use_with_caution',
    applies: (f) => {
      const later = contentSignatures(f).filter(
        (s) =>
          s.verdict === Verdict.VALID &&
          s.revocation?.status === RevocationStatus.REVOKED_AFTER_VALIDATION_TIME,
      );
      return later.length > 0
        ? `Signer certificate was revoked after the time a timestamp proves the signature existed (signature stands; the certificate must not be relied on for new signatures): ${later.map(label).join(', ')}`
        : null;
    },
  },
  {
    ruleId: 'POL-CAUTION-WEAK-DIGEST',
    verdict: 'use_with_caution',
    applies: (f) => {
      const weak = contentSignatures(f).filter(
        (s) => s.cms?.digestAlgorithm && WEAK_DIGESTS.has(s.cms.digestAlgorithm),
      );
      return weak.length > 0
        ? `Weak digest algorithm (integrity assurance is limited): ${weak.map((s) => `${label(s)} [${s.cms?.digestAlgorithm}]`).join(', ')}`
        : null;
    },
  },
  {
    // #20: a redaction annotation marks content that is *intended* to be removed
    // (ISO 32000-2 §12.5.6.23). Applying the redaction removes both the annotation and the
    // content it covers, so one still in the file means the redaction was never applied and
    // the covered content is still there. For a document handed over as "redacted", that is
    // the difference between redacted and not. The verdict stays at caution because the
    // engine judges authenticity, not whether the author finished their work — but a reader
    // acting on the file must know before trusting what it does not show.
    ruleId: 'POL-CAUTION-REDACT-PENDING',
    verdict: 'use_with_caution',
    applies: (f) => {
      const c = f.content;
      if (!c || c.redactAnnotations === 0) return null;
      const overlay =
        c.redactWithOverlay > 0
          ? ` (${c.redactWithOverlay} with a prepared overlay appearance)`
          : '';
      return (
        `${c.redactAnnotations} redaction annotation(s) (/Subtype /Redact) still present${overlay}: ` +
        'ISO 32000-2 §12.5.6.23 — an applied redaction leaves no annotation behind, so the ' +
        'content these annotations mark has NOT been removed from the file and can be extracted'
      );
    },
  },
  {
    // #21: the document does something when opened or used — runs code, starts another
    // program, opens another file, or sends form data out. None of this is forbidden in PDF,
    // and none of it bears on authenticity, which is why it is caution and not review. It is
    // reported because the PDF Association's "FAQ: AI and PDF" names it as what an ingestion
    // system must know about a file before processing it, and because the PDF/A rule that
    // used to be the only place these were counted never ran for an ordinary PDF.
    ruleId: 'POL-CAUTION-ACTIVE-CONTENT',
    verdict: 'use_with_caution',
    applies: (f) => {
      const c = f.content;
      if (!c) return null;
      const parts: string[] = [];
      if (c.actions.JavaScriptActions > 0) {
        parts.push(
          `${c.actions.JavaScriptActions} ECMAScript action(s), ${c.javaScriptBytes} bytes of script (§12.6.4.17)`,
        );
      }
      if (c.actions.LaunchActions > 0) {
        parts.push(
          `${c.actions.LaunchActions} Launch action(s) — starts an application or opens a file (§12.6.4.6)`,
        );
      }
      if (c.actions.GoToRemoteActions > 0) {
        parts.push(
          `${c.actions.GoToRemoteActions} remote go-to action(s) — targets another file (§12.6.4.3/.4)`,
        );
      }
      if (c.actions.SubmitFormActions > 0) {
        parts.push(
          `${c.actions.SubmitFormActions} SubmitForm/ImportData action(s) — sends or loads form data (§12.7.6)`,
        );
      }
      if (parts.length === 0) return null;
      const trigger =
        c.openAction || c.documentAdditionalActions
          ? ' The catalog has /OpenAction or /AA, so some of this runs when the document is opened, before anyone reads it.'
          : '';
      return `The document carries active content (ISO 32000-2 §12.8.7 counts): ${parts.join('; ')}.${trigger}`;
    },
  },
];

export function evaluatePolicy(facts: PolicyFacts, profileId: PolicyProfileId): PolicyEvaluation {
  const profile = POLICY_PROFILES[profileId];
  const firedRules: FiredRule[] = [];
  const advisories: string[] = [];

  for (const rule of RULES) {
    const reason = rule.applies(facts, profile);
    if (reason !== null) {
      firedRules.push({ ruleId: rule.ruleId, verdict: rule.verdict, reason });
    }
  }

  let verdict: PolicyVerdict = 'trust_and_use';
  for (const fired of firedRules) {
    if (SEVERITY[fired.verdict] > SEVERITY[verdict]) verdict = fired.verdict;
  }

  // Profile escalation (medical): no intermediate state for patient data
  if (profile.escalateCautionToReview && verdict === 'use_with_caution') {
    verdict = 'human_review_required';
    firedRules.push({
      ruleId: 'POL-ESCALATE-CAUTION',
      verdict: 'human_review_required',
      reason: `Profile "${profile.id}" escalates use_with_caution to human_review_required`,
    });
  }

  // ---- Advisories (never change the verdict) ----

  const signed = contentSignatures(facts);
  if (profile.recommendedMinPadesLevel && signed.length > 0) {
    const order = [PadesLevel.B_B, PadesLevel.B_T, PadesLevel.B_LT, PadesLevel.B_LTA];
    const min = order.indexOf(profile.recommendedMinPadesLevel);
    const below = facts.pades.filter((p) => p.level !== null && order.indexOf(p.level) < min);
    if (below.length > 0) {
      advisories.push(
        `PAdES level below the profile's recommendation (${profile.recommendedMinPadesLevel}): ` +
          `${below.map((p) => `${p.fieldName ?? '(unnamed)'}=${p.level}`).join(', ')} — ` +
          'the signature may become unverifiable after certificate expiry/revocation; consider LTV augmentation' +
          ' (level is inferred from structure — ETSI EN 319 142 is not in this corpus, so this is not a conformance finding)',
      );
    }
    // A signature that is not even a PAdES baseline (level === null, e.g. a
    // legacy ISO 32000-1 adbe.pkcs7.detached signature) has weaker long-term
    // verifiability than B-B — no signature timestamp, no DSS. The `below`
    // filter deliberately excludes null so that order.indexOf(null) === -1
    // cannot mis-sort it; surface these separately with a message that does not
    // presuppose a PAdES baseline (LTV augmentation only makes sense on one).
    const nonPades = facts.pades.filter((p) => p.level === null);
    if (nonPades.length > 0) {
      advisories.push(
        'Signature is not a PAdES baseline (legacy adbe.pkcs7.detached / ISO 32000-1): ' +
          `${nonPades.map((p) => p.fieldName ?? '(unnamed)').join(', ')} — ` +
          'weaker long-term verifiability than B-B (no signature timestamp or DSS); ' +
          `if long-term preservation is required, migrate to a PAdES baseline (min ${profile.recommendedMinPadesLevel})` +
          ' (inferred from the SubFilter and structure, not from ETSI text)',
      );
    }
  }
  if (facts.conformance && facts.conformance.compliant === false) {
    advisories.push(
      `${facts.conformance.flavour} validation found violations (engine: ${facts.conformance.engine}) — not ideal as a long-term preservation format`,
    );
    // #23: when one of those violations is the XMP extension-schema rule and the detail
    // names the namespace, say so here too — a reader of the verdict should not have to open
    // the violation list to learn that the archival failure is "TDMRep without an extension
    // schema", which is fixable by the producer and does not touch the document's content.
    const schemaViolations = facts.conformance.violations.filter(
      (v) => isXmpSchemaClause(v.clause) && v.detail?.includes('neither predefined nor described'),
    );
    for (const v of schemaViolations) {
      advisories.push(`${v.clause}: ${v.detail}`);
    }
  }
  // The archival check ran, but not with the validator that can settle it. This
  // never moves the verdict (the subset found nothing to disprove, which is all
  // it can ever say) — it stops "no violations detected" from being read as an
  // archival pass when the authoritative validator never spoke.
  if (facts.conformance && !facts.conformance.authoritativeValidation.performed) {
    advisories.push(
      `${facts.conformance.flavour} was checked with the native rule subset only — ${facts.conformance.authoritativeValidation.detail} ` +
        'The subset can disprove conformance but cannot certify it, so long-term preservation suitability is UNDETERMINED here, not confirmed',
    );
  }
  if (facts.integrity.certification?.laterChangesAppearLtvOnly) {
    advisories.push(
      'Changes after certification appear to be DSS/document-timestamp updates (permitted by ISO 32000-2 §12.8.2.2); object-level confirmation was not performed',
    );
  }
  // Non-certified signatures: bytes were added after a signature's signed
  // range. This is legal in PDF (counter-signatures, DSS/LTV augmentation,
  // incremental annotations) so it never changes the verdict. For certified
  // (DocMDP) documents the dedicated rule/advisory above already reports it,
  // so only surface the otherwise-silent non-certified path here — closing the
  // gap where "something was added after signing" reached neither facts nor
  // advisories for ordinary signatures.
  if (!facts.integrity.certification && facts.integrity.signaturesWithLaterChanges.length > 0) {
    advisories.push(
      'Content was added after signing (incremental update): ' +
        `${facts.integrity.signaturesWithLaterChanges
          .map((c) => `${c.fieldName ?? '(unnamed)'}=+${c.bytesAfterSignedRange}B`)
          .join(', ')} — ` +
        'incremental updates are permitted in PDF, but the added content is not covered by that signature; review what was added',
    );
  }
  // #21: URI actions are ordinary in documents (links), so they never change the verdict;
  // the hosts are listed so a reader can see where the document points.
  if (facts.content && facts.content.actions.URIActions > 0) {
    const hosts = facts.content.uriHosts;
    advisories.push(
      `${facts.content.actions.URIActions} URI action(s) (§12.6.4.8) pointing at: ${hosts.length > 0 ? hosts.join(', ') : '(no host could be read)'}` +
        (hosts.length >= 32 ? ' … (host list capped at 32)' : ''),
    );
  }
  if (facts.content === null) {
    advisories.push(
      'Content inventory (ISO 32000-2 §12.8.7 counts: scripts, launch/remote actions, redaction annotations) could not be taken — record it as "not counted", not as 0',
    );
  } else if (facts.content && facts.content.unreadableObjects > 0) {
    advisories.push(
      `Content inventory walked ${facts.content.objectsRead} objects; ${facts.content.unreadableObjects} named by the cross-reference table could not be read, so its counts are lower bounds`,
    );
  }
  const expired = signed.filter((s) => s.cms?.signerCertificate?.isExpiredNow);
  if (expired.length > 0) {
    advisories.push(
      `Signer certificate expired as of now (may have been valid at signing): ${expired.map(label).join(', ')} — timestamps/LTV determine long-term verifiability`,
    );
  }

  return {
    profile: profileId,
    verdict,
    firedRules,
    advisories,
    notes: [
      'This verdict is produced by a deterministic rule engine over the verification facts — same facts, same profile, same verdict. It judges authenticity/integrity only, never the truth of the content.',
      'trust_and_use requires: all signatures valid, all chains trusted, revocation confirmed good, and no profile rule fired.',
      // T3: PAdES レベルは観測であって適合判定ではない（specs/09 §2 / Issue #9）。
      // facts.padesLevels だけを抜き出して「PAdES 準拠」と書かれるのを防ぐ
      ...(facts.pades.length > 0
        ? [
            'PAdES levels in the facts are inferred from document structure, not from ETSI EN 319 142 (which is outside this corpus). Report them as observations; do not restate them as conformance.',
          ]
        : []),
    ],
  };
}
