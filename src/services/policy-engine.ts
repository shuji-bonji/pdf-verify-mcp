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
import type { IntegrityReport, PadesLevelReport, SignatureVerificationReport } from '../types.js';
import type { ConformanceValidationReport } from './conformance-validation.js';

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
      f.integrity.certification?.violatedByLaterChanges
        ? `DocMDP permission ${f.integrity.certification.permission} violated by changes after certification`
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
          'the signature may become unverifiable after certificate expiry/revocation; consider LTV augmentation',
      );
    }
  }
  if (facts.conformance && facts.conformance.compliant === false) {
    advisories.push(
      `${facts.conformance.flavour} validation found violations (engine: ${facts.conformance.engine}) — not ideal as a long-term preservation format`,
    );
  }
  if (facts.integrity.certification?.laterChangesAppearLtvOnly) {
    advisories.push(
      'Changes after certification appear to be DSS/document-timestamp updates (permitted by ISO 32000-2 §12.8.2.2); object-level confirmation was not performed',
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
    ],
  };
}
