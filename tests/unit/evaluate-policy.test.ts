/**
 * Issue #4: deterministic trust-policy engine.
 *
 * The whole point is that the verdict is a pure function of facts + profile,
 * so the engine is tested directly with synthetic facts (every rule pinned in
 * isolation), plus integration paths over real signed/tampered/unsigned PDFs.
 */

import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { PadesLevel, RevocationStatus, TrustStatus, Verdict } from '../../src/constants.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import {
  evaluatePolicy,
  POLICY_PROFILES,
  type PolicyFacts,
  type PolicyProfileId,
} from '../../src/services/policy-engine.js';
import {
  analyzeIntegrity,
  detectPadesLevels,
  verifySignatures,
} from '../../src/services/verification-service.js';
import type {
  IntegrityReport,
  PadesLevelReport,
  SignatureVerificationReport,
} from '../../src/types.js';
import {
  createSignedPdf,
  createTestIdentity,
  type TestIdentity,
  tamperSignedPdf,
} from '../helpers/signed-pdf.js';

// ---------------------------------------------------------------------------
// Synthetic-facts helpers
// ---------------------------------------------------------------------------

function sig(over: Partial<SignatureVerificationReport> = {}): SignatureVerificationReport {
  return {
    fieldName: 'Sig1',
    subFilter: 'ETSI.CAdES.detached',
    verdict: Verdict.VALID,
    trust: { status: TrustStatus.TRUSTED, detail: null, certificatePath: null },
    revocation: { status: RevocationStatus.GOOD, source: 'crl_embedded', detail: null },
    coversEntireFile: true,
    bytesAfterSignedRange: 0,
    cms: null,
    signingTimeDictionary: null,
    reason: null,
    location: null,
    isDocumentTimestamp: false,
    notes: [],
    ...over,
  };
}

function integrity(over: Partial<IntegrityReport> = {}): IntegrityReport {
  return {
    fileSize: 1000,
    revisionCount: 1,
    incrementalUpdateCount: 0,
    signatureCount: 1,
    signaturesWithLaterChanges: [],
    certification: null,
    lastSignatureCoversFile: true,
    hasDss: false,
    notes: [],
    ...over,
  };
}

function pades(over: Partial<PadesLevelReport> = {}): PadesLevelReport {
  return {
    fieldName: 'Sig1',
    subFilter: 'ETSI.CAdES.detached',
    isPades: true,
    level: PadesLevel.B_T,
    evidence: {
      hasSignatureTimestamp: true,
      hasDss: false,
      hasVri: false,
      hasDocumentTimestamp: false,
    },
    ltv: null,
    notes: [],
    ...over,
  };
}

function facts(over: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    signatures: [sig()],
    integrity: integrity(),
    pades: [],
    conformance: null,
    ...over,
  };
}

const ids = (e: ReturnType<typeof evaluatePolicy>) => e.firedRules.map((r) => r.ruleId);
const hasAdvisory = (e: ReturnType<typeof evaluatePolicy>, needle: string) =>
  e.advisories.some((a) => a.includes(needle));
const PROFILE_IDS = Object.keys(POLICY_PROFILES) as PolicyProfileId[];

describe('policy engine (synthetic facts)', () => {
  it('fully positive facts → trust_and_use with no fired rules', () => {
    const e = evaluatePolicy(facts(), 'general');
    expect(e.verdict).toBe('trust_and_use');
    expect(e.firedRules).toEqual([]);
  });

  it('invalid signature → reject', () => {
    const e = evaluatePolicy(facts({ signatures: [sig({ verdict: Verdict.INVALID })] }), 'general');
    expect(e.verdict).toBe('reject');
    expect(ids(e)).toContain('POL-REJECT-INVALID');
  });

  it('revoked certificate → reject', () => {
    const e = evaluatePolicy(
      facts({
        signatures: [
          sig({
            revocation: { status: RevocationStatus.REVOKED, source: 'crl_embedded', detail: null },
          }),
        ],
      }),
      'general',
    );
    expect(e.verdict).toBe('reject');
    expect(ids(e)).toContain('POL-REJECT-REVOKED');
  });

  it('indeterminate signature → human_review_required', () => {
    const e = evaluatePolicy(
      facts({ signatures: [sig({ verdict: Verdict.INDETERMINATE })] }),
      'general',
    );
    expect(e.verdict).toBe('human_review_required');
    expect(ids(e)).toContain('POL-REVIEW-INDETERMINATE');
  });

  it('DocMDP violation → human_review_required', () => {
    const e = evaluatePolicy(
      facts({
        integrity: integrity({
          certification: {
            fieldName: 'Sig1',
            permission: 1,
            permissionDescription: 'No changes permitted',
            violatedByLaterChanges: true,
            laterChangesAppearLtvOnly: false,
          },
        }),
      }),
      'general',
    );
    expect(e.verdict).toBe('human_review_required');
    expect(ids(e)).toContain('POL-REVIEW-DOCMDP-VIOLATION');
  });

  it('valid but trust not_evaluated → use_with_caution', () => {
    const e = evaluatePolicy(
      facts({
        signatures: [
          sig({
            trust: { status: TrustStatus.NOT_EVALUATED, detail: null, certificatePath: null },
          }),
        ],
      }),
      'general',
    );
    expect(e.verdict).toBe('use_with_caution');
    expect(ids(e)).toContain('POL-CAUTION-TRUST-NOT-EVALUATED');
  });

  it('revocation unknown → use_with_caution', () => {
    const e = evaluatePolicy(
      facts({
        signatures: [
          sig({ revocation: { status: RevocationStatus.UNKNOWN, source: null, detail: null } }),
        ],
      }),
      'general',
    );
    expect(e.verdict).toBe('use_with_caution');
    expect(ids(e)).toContain('POL-CAUTION-REVOCATION-UNKNOWN');
  });

  it('unsigned: general → caution, contract/medical → review', () => {
    const unsigned = facts({ signatures: [], integrity: integrity({ signatureCount: 0 }) });
    expect(evaluatePolicy(unsigned, 'general').verdict).toBe('use_with_caution');
    expect(evaluatePolicy(unsigned, 'contract').verdict).toBe('human_review_required');
    expect(evaluatePolicy(unsigned, 'medical').verdict).toBe('human_review_required');
  });

  it('medical escalates use_with_caution to human_review_required', () => {
    const notEvaluated = facts({
      signatures: [
        sig({ trust: { status: TrustStatus.NOT_EVALUATED, detail: null, certificatePath: null } }),
      ],
    });
    expect(evaluatePolicy(notEvaluated, 'general').verdict).toBe('use_with_caution');
    const medical = evaluatePolicy(notEvaluated, 'medical');
    expect(medical.verdict).toBe('human_review_required');
    expect(ids(medical)).toContain('POL-ESCALATE-CAUTION');
  });

  it('reject wins over caution and review (severity order)', () => {
    const e = evaluatePolicy(
      facts({
        signatures: [
          sig({ verdict: Verdict.INVALID }),
          sig({ fieldName: 'Sig2', verdict: Verdict.INDETERMINATE }),
        ],
      }),
      'general',
    );
    expect(e.verdict).toBe('reject');
  });

  it('document timestamps do not count as content signatures', () => {
    const e = evaluatePolicy(
      facts({
        signatures: [sig({ isDocumentTimestamp: true, verdict: Verdict.INDETERMINATE })],
        integrity: integrity({ signatureCount: 0 }),
      }),
      'general',
    );
    // Only a DTS: the document is effectively unsigned → caution, not review
    expect(e.verdict).toBe('use_with_caution');
    expect(ids(e)).toContain('POL-CAUTION-UNSIGNED');
  });

  it('is deterministic: same facts, same verdict, byte-identical output', () => {
    const f = facts({ signatures: [sig({ verdict: Verdict.INVALID })] });
    const a = JSON.stringify(evaluatePolicy(f, 'contract'));
    const b = JSON.stringify(evaluatePolicy(f, 'contract'));
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Advisories (never change the verdict) — FINDINGS-2026-07-20 V-A1 / V-A2
// ---------------------------------------------------------------------------

describe('V-A1: post-signing changes on non-certified signatures', () => {
  // signed-then-annotated.pdf shape: a valid (trust-not-evaluated) signature
  // followed by a 574-byte incremental update, no DocMDP certification.
  const withLaterChanges = facts({
    signatures: [
      sig({ trust: { status: TrustStatus.NOT_EVALUATED, detail: null, certificatePath: null } }),
    ],
    integrity: integrity({
      incrementalUpdateCount: 2,
      lastSignatureCoversFile: false,
      signaturesWithLaterChanges: [{ fieldName: 'Sig1', bytesAfterSignedRange: 574 }],
    }),
  });

  it('surfaces an advisory for content added after signing', () => {
    const e = evaluatePolicy(withLaterChanges, 'contract');
    expect(hasAdvisory(e, 'Content was added after signing')).toBe(true);
    expect(hasAdvisory(e, '+574B')).toBe(true);
  });

  it('never changes the verdict (incremental update is legal in PDF)', () => {
    for (const p of PROFILE_IDS) {
      const withChanges = evaluatePolicy(withLaterChanges, p).verdict;
      const withoutChanges = evaluatePolicy(
        facts({
          signatures: [
            sig({
              trust: { status: TrustStatus.NOT_EVALUATED, detail: null, certificatePath: null },
            }),
          ],
        }),
        p,
      ).verdict;
      expect(withChanges).toBe(withoutChanges);
    }
  });

  it('does not double-report when DocMDP certification already covers it', () => {
    // Negative control: certified-p1-modified.pdf — the DocMDP rule/advisory
    // path owns this case, so the non-certified advisory must stay silent.
    const certified = facts({
      integrity: integrity({
        incrementalUpdateCount: 1,
        signaturesWithLaterChanges: [{ fieldName: 'Sig1', bytesAfterSignedRange: 120 }],
        certification: {
          fieldName: 'Sig1',
          permission: 1,
          permissionDescription: 'No changes permitted',
          violatedByLaterChanges: true,
          laterChangesAppearLtvOnly: false,
        },
      }),
    });
    const e = evaluatePolicy(certified, 'contract');
    expect(hasAdvisory(e, 'Content was added after signing')).toBe(false);
    expect(ids(e)).toContain('POL-REVIEW-DOCMDP-VIOLATION');
  });
});

describe('V-A2: non-PAdES (level === null) signatures', () => {
  // A legacy adbe.pkcs7.detached signature — not a PAdES baseline at all.
  const legacy = facts({
    signatures: [
      sig({ trust: { status: TrustStatus.NOT_EVALUATED, detail: null, certificatePath: null } }),
    ],
    pades: [pades({ isPades: false, level: null, subFilter: 'adbe.pkcs7.detached' })],
  });

  it('emits a distinct non-PAdES advisory for every PAdES-caring profile', () => {
    for (const p of PROFILE_IDS) {
      const e = evaluatePolicy(legacy, p);
      if (POLICY_PROFILES[p].recommendedMinPadesLevel) {
        expect(hasAdvisory(e, 'not a PAdES baseline')).toBe(true);
        // The B-B "consider LTV augmentation" wording presupposes a PAdES
        // baseline and must NOT be reused for a non-PAdES signature.
        expect(hasAdvisory(e, 'consider LTV augmentation')).toBe(false);
      } else {
        // general: no recommendedMinPadesLevel → stays quiet.
        expect(hasAdvisory(e, 'not a PAdES baseline')).toBe(false);
      }
    }
  });

  it('negative control: a real B-B signature keeps the LTV-augmentation wording', () => {
    const bb = facts({ pades: [pades({ level: PadesLevel.B_B })] });
    const e = evaluatePolicy(bb, 'contract'); // recommends B-T
    expect(hasAdvisory(e, 'consider LTV augmentation')).toBe(true);
    expect(hasAdvisory(e, 'not a PAdES baseline')).toBe(false);
  });

  it('never changes the verdict', () => {
    for (const p of PROFILE_IDS) {
      const withLegacy = evaluatePolicy(legacy, p).verdict;
      const baseline = evaluatePolicy(
        facts({
          signatures: [
            sig({
              trust: { status: TrustStatus.NOT_EVALUATED, detail: null, certificatePath: null },
            }),
          ],
          pades: [pades()],
        }),
        p,
      ).verdict;
      expect(withLegacy).toBe(baseline);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration over real PDFs
// ---------------------------------------------------------------------------

let identity: TestIdentity;

async function evaluateBytes(bytes: Uint8Array, profile: Parameters<typeof evaluatePolicy>[1]) {
  const parsed = await parsePdfBytes(bytes);
  const signatures = await verifySignatures(parsed);
  const integrityReport = analyzeIntegrity(parsed);
  const pades = await detectPadesLevels(parsed);
  return evaluatePolicy(
    { signatures, integrity: integrityReport, pades, conformance: null },
    profile,
  );
}

describe('policy engine (real documents)', () => {
  beforeAll(async () => {
    identity = await createTestIdentity();
  });

  it('valid self-signed, no anchors → use_with_caution (identity not evaluated)', async () => {
    const e = await evaluateBytes(await createSignedPdf(identity), 'general');
    expect(e.verdict).toBe('use_with_caution');
    expect(ids(e)).toContain('POL-CAUTION-TRUST-NOT-EVALUATED');
  });

  it('tampered document → reject', async () => {
    const e = await evaluateBytes(tamperSignedPdf(await createSignedPdf(identity)), 'general');
    expect(e.verdict).toBe('reject');
    expect(ids(e)).toContain('POL-REJECT-INVALID');
  });

  it('unsigned document → profile decides', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const bytes = await doc.save();
    expect((await evaluateBytes(bytes, 'general')).verdict).toBe('use_with_caution');
    expect((await evaluateBytes(bytes, 'contract')).verdict).toBe('human_review_required');
  });
});
