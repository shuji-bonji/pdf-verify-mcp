/**
 * #20 / #21: content inventory (ISO 32000-2 §12.8.7 counts, redaction annotations) and the
 * two policy rules that read it.
 *
 * The inventory is an observation; it is tested on a real pdf-lib document with one of each
 * thing it counts. The rules are tested on synthetic facts, one condition at a time.
 */

import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { RevocationStatus, TrustStatus, Verdict } from '../../src/constants.js';
import { inventoryContent } from '../../src/services/content-inventory.js';
import { loadPdfDocument } from '../../src/services/pdf-parser.js';
import {
  evaluatePolicy,
  type PolicyFacts,
  type PolicyProfileId,
} from '../../src/services/policy-engine.js';
import type {
  ContentInventory,
  IntegrityReport,
  SignatureVerificationReport,
} from '../../src/types.js';

// ─── a document with one of each ───

async function buildActiveDocument(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage([595, 842]);
  page.drawText('redacted document', { x: 50, y: 780, size: 14 });

  // A redaction annotation that was never applied (§12.5.6.23), with an overlay prepared.
  const redact = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Redact',
      Rect: [50, 700, 300, 720],
      OverlayText: PDFString.of('REDACTED'),
    }),
  );
  // A link whose action is written inline (a direct dictionary — not an indirect object).
  const link = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [50, 650, 300, 670],
      A: ctx.obj({ S: 'URI', URI: PDFString.of('https://example.org/path') }),
    }),
  );
  // A Launch action, as an indirect object, reached from a second link.
  const launch = ctx.register(ctx.obj({ S: 'Launch', F: PDFString.of('cmd.exe') }));
  const link2 = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 600, 300, 620], A: launch }),
  );
  page.node.set(PDFName.of('Annots'), ctx.obj([redact, link, link2]));

  // JavaScript on open, chained after a GoToR.
  doc.catalog.set(
    PDFName.of('OpenAction'),
    ctx.obj({
      S: 'GoToR',
      F: PDFString.of('other.pdf'),
      D: [0, 'Fit'],
      Next: ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1);') }),
    }),
  );
  return doc.save({ useObjectStreams: false });
}

async function buildPlainDocument(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]).drawText('plain', { x: 50, y: 780, size: 14 });
  return doc.save({ useObjectStreams: false });
}

describe('content inventory (real documents)', () => {
  let active: ContentInventory;
  let plain: ContentInventory;

  beforeAll(async () => {
    active = await inventoryContent(await loadPdfDocument(await buildActiveDocument()));
    plain = await inventoryContent(await loadPdfDocument(await buildPlainDocument()));
  });

  it('CI-1: counts each Table 264 action kind, inline or indirect', () => {
    expect(active.actions).toEqual({
      JavaScriptActions: 1,
      LaunchActions: 1,
      URIActions: 1,
      MovieActions: 0,
      SoundActions: 0,
      HideAnnotationActions: 0,
      GoToRemoteActions: 1,
      SubmitFormActions: 0,
    });
    expect(active.javaScriptBytes).toBe('app.alert(1);'.length);
    expect(active.uriHosts).toEqual(['example.org']);
    expect(active.openAction).toBe(true);
    expect(active.documentAdditionalActions).toBe(false);
  });

  it('CI-2: counts annotations and the redaction annotations still present', () => {
    expect(active.annotations).toBe(3);
    expect(active.redactAnnotations).toBe(1);
    expect(active.redactWithOverlay).toBe(1);
  });

  it('CI-3: a plain document is all zeros — observed, with every object read', () => {
    expect(Object.values(plain.actions).every((n) => n === 0)).toBe(true);
    expect(plain.redactAnnotations).toBe(0);
    expect(plain.annotations).toBe(0);
    expect(plain.openAction).toBe(false);
    expect(plain.unreadableObjects).toBe(0);
    expect(plain.objectsRead).toBeGreaterThan(0);
  });
});

// ─── the rules, on synthetic facts ───

function sig(): SignatureVerificationReport {
  return {
    fieldName: 'Sig1',
    verdict: Verdict.VALID,
    isDocumentTimestamp: false,
    trust: { status: TrustStatus.TRUSTED, chain: [], detail: null },
    revocation: { status: RevocationStatus.GOOD, source: 'ocsp_embedded', detail: null },
    cms: null,
    timestamp: null,
    reasons: [],
  } as unknown as SignatureVerificationReport;
}

function integrity(): IntegrityReport {
  return {
    revisionCount: 1,
    incrementalUpdateCount: 0,
    lastSignatureCoversFile: true,
    signaturesWithLaterChanges: [],
    certification: null,
    hasDss: false,
  } as unknown as IntegrityReport;
}

function inventory(over: Partial<ContentInventory> = {}): ContentInventory {
  return {
    actions: {
      JavaScriptActions: 0,
      LaunchActions: 0,
      URIActions: 0,
      MovieActions: 0,
      SoundActions: 0,
      HideAnnotationActions: 0,
      GoToRemoteActions: 0,
      SubmitFormActions: 0,
    },
    javaScriptBytes: 0,
    uriHosts: [],
    openAction: false,
    documentAdditionalActions: false,
    annotations: 0,
    redactAnnotations: 0,
    redactWithOverlay: 0,
    optionalContent: false,
    embeddedFiles: 0,
    objectsRead: 10,
    unreadableObjects: 0,
    ...over,
  };
}

function facts(content: ContentInventory | null | undefined): PolicyFacts {
  return { signatures: [sig()], integrity: integrity(), pades: [], conformance: null, content };
}

const ids = (e: ReturnType<typeof evaluatePolicy>) => e.firedRules.map((r) => r.ruleId);

describe('POL-CAUTION-REDACT-PENDING (#20)', () => {
  it('fires on a redaction annotation still present and names §12.5.6.23', () => {
    const e = evaluatePolicy(
      facts(inventory({ redactAnnotations: 2, redactWithOverlay: 1 })),
      'general',
    );
    expect(e.verdict).toBe('use_with_caution');
    expect(ids(e)).toContain('POL-CAUTION-REDACT-PENDING');
    const rule = e.firedRules.find((r) => r.ruleId === 'POL-CAUTION-REDACT-PENDING');
    expect(rule?.reason).toContain('2 redaction annotation(s)');
    expect(rule?.reason).toContain('1 with a prepared overlay');
    expect(rule?.reason).toContain('§12.5.6.23');
    expect(rule?.reason).toContain('NOT been removed');
  });

  it('does not fire at 0, and the verdict stays trust_and_use', () => {
    const e = evaluatePolicy(facts(inventory()), 'general');
    expect(ids(e)).not.toContain('POL-CAUTION-REDACT-PENDING');
    expect(e.verdict).toBe('trust_and_use');
  });

  it('medical escalates it to human_review_required like any caution', () => {
    const e = evaluatePolicy(facts(inventory({ redactAnnotations: 1 })), 'medical');
    expect(e.verdict).toBe('human_review_required');
    expect(ids(e)).toContain('POL-ESCALATE-CAUTION');
  });
});

describe('POL-CAUTION-ACTIVE-CONTENT (#21)', () => {
  it('fires on JavaScript and says it runs on open when /OpenAction is present', () => {
    const e = evaluatePolicy(
      facts(
        inventory({
          actions: { ...inventory().actions, JavaScriptActions: 1 },
          javaScriptBytes: 13,
          openAction: true,
        }),
      ),
      'general',
    );
    expect(e.verdict).toBe('use_with_caution');
    const rule = e.firedRules.find((r) => r.ruleId === 'POL-CAUTION-ACTIVE-CONTENT');
    expect(rule?.reason).toContain('1 ECMAScript action(s), 13 bytes');
    expect(rule?.reason).toContain('runs when the document is opened');
  });

  it('fires on Launch, GoToR and SubmitForm each on their own', () => {
    for (const key of ['LaunchActions', 'GoToRemoteActions', 'SubmitFormActions'] as const) {
      const e = evaluatePolicy(
        facts(inventory({ actions: { ...inventory().actions, [key]: 1 } })),
        'general',
      );
      expect(ids(e), key).toContain('POL-CAUTION-ACTIVE-CONTENT');
    }
  });

  it('URI actions alone never change the verdict; the hosts go to an advisory', () => {
    const e = evaluatePolicy(
      facts(
        inventory({
          actions: { ...inventory().actions, URIActions: 3 },
          uriHosts: ['a.example', 'b.example'],
        }),
      ),
      'general',
    );
    expect(e.verdict).toBe('trust_and_use');
    expect(ids(e)).not.toContain('POL-CAUTION-ACTIVE-CONTENT');
    expect(
      e.advisories.some((a) => a.includes('3 URI action(s)') && a.includes('a.example, b.example')),
    ).toBe(true);
  });

  it('a null inventory is "not counted": no rule fires, an advisory says so', () => {
    const e = evaluatePolicy(facts(null), 'general');
    expect(ids(e)).not.toContain('POL-CAUTION-ACTIVE-CONTENT');
    expect(ids(e)).not.toContain('POL-CAUTION-REDACT-PENDING');
    expect(
      e.advisories.some((a) => a.includes('could not be taken') && a.includes('not counted')),
    ).toBe(true);
  });

  it('unreadable objects make the counts lower bounds, said in an advisory', () => {
    const e = evaluatePolicy(facts(inventory({ unreadableObjects: 4 })), 'general');
    expect(
      e.advisories.some((a) =>
        a.includes('4 named by the cross-reference table could not be read'),
      ),
    ).toBe(true);
  });

  it('facts without the field (older callers) behave as before', () => {
    const e = evaluatePolicy(facts(undefined), 'general');
    expect(e.verdict).toBe('trust_and_use');
    expect(e.advisories.some((a) => a.includes('Content inventory'))).toBe(false);
  });

  it('every profile accepts the field', () => {
    for (const p of [
      'general',
      'contract',
      'financial',
      'legal',
      'medical',
      'government',
    ] as PolicyProfileId[]) {
      expect(() => evaluatePolicy(facts(inventory({ redactAnnotations: 1 })), p)).not.toThrow();
    }
  });
});
