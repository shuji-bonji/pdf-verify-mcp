/**
 * v0.27.0: validation time (#12), revocation time and signed revocation data
 * (#13), revocation data origin (#15), not_checked (#14).
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PadesLevel,
  RevocationMode,
  RevocationStatus,
  TrustStatus,
  Verdict,
} from '../../src/constants.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { evaluatePolicy } from '../../src/services/policy-engine.js';
import {
  analyzeIntegrity,
  chooseValidationTime,
  detectPadesLevels,
  verifySignatures,
} from '../../src/services/verification-service.js';
import type { SignatureField } from '../../src/types.js';
import {
  certificateDer,
  certificateToPem,
  createCrl,
  createIdentity,
  createOcspResponse,
  createSignedPdf,
  createTestCa,
  type TestIdentity,
} from '../helpers/signed-pdf.js';

const HOUR = 3600 * 1000;
const YEAR = 365 * 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

let ca: TestIdentity;
let leaf: TestIdentity;
let tsa: TestIdentity;
let caPemPath: string;

beforeAll(async () => {
  ca = await createIdentity({ commonName: 'rt CA', isCa: true, notBefore: ago(10 * YEAR) });
  leaf = await createIdentity({ commonName: 'rt leaf', issuer: ca });
  tsa = await createIdentity({ commonName: 'rt TSA', issuer: ca, notBefore: ago(5 * YEAR) });
  const dir = await mkdtemp(join(tmpdir(), 'pdf-verify-rt-'));
  caPemPath = join(dir, 'ca.pem');
  await writeFile(caPemPath, certificateToPem(ca));
});

async function verifyOne(pdf: Uint8Array, opts: Parameters<typeof verifySignatures>[1] = {}) {
  const [report] = await verifySignatures(await parsePdfBytes(pdf), opts);
  return report;
}

describe('#14 check_revocation none', () => {
  it('reports not_checked instead of null', async () => {
    const report = await verifyOne(await createSignedPdf(leaf), {
      revocationMode: RevocationMode.NONE,
    });
    expect(report.revocation?.status).toBe(RevocationStatus.NOT_CHECKED);
    expect(report.revocation?.source).toBeNull();
  });
});

describe('#15 revocation data origin', () => {
  it('reads OCSP from adbe-revocationInfoArchival', async () => {
    const ocsp = await createOcspResponse({
      responder: ca,
      issuer: ca,
      subject: leaf,
      status: 'good',
    });
    const report = await verifyOne(
      await createSignedPdf(leaf, {
        cms: { certificates: [ca], revocationArchival: { ocsps: [ocsp] } },
      }),
    );
    expect(report.revocation).toMatchObject({
      status: RevocationStatus.GOOD,
      source: 'ocsp_embedded',
      origin: 'cms_revocation_info_archival',
    });
  });

  it('reads CRLs from adbe-revocationInfoArchival', async () => {
    const crl = await createCrl(ca, []);
    const report = await verifyOne(
      await createSignedPdf(leaf, {
        cms: { certificates: [ca], revocationArchival: { crls: [crl] } },
      }),
    );
    expect(report.revocation).toMatchObject({
      status: RevocationStatus.GOOD,
      source: 'crl_embedded',
      origin: 'cms_revocation_info_archival',
    });
  });

  it('tags SignedData.crls and DSS separately', async () => {
    const crl = await createCrl(ca, []);
    const fromCms = await verifyOne(
      await createSignedPdf(leaf, { cms: { certificates: [ca], crls: [crl] } }),
    );
    expect(fromCms.revocation?.origin).toBe('cms_signed_data');
    const fromDss = await verifyOne(
      await createSignedPdf(leaf, { cms: { certificates: [ca] }, dss: { crls: [crl] } }),
    );
    expect(fromDss.revocation?.origin).toBe('dss');
    expect(fromDss.revocation?.detail).toContain('DSS');
  });

  it('B-LT counts only DSS revocation data (a CMS CRL does not cover the signer)', async () => {
    const crl = await createCrl(ca, []);
    const pdf = await createSignedPdf(leaf, {
      tsa,
      cms: { certificates: [ca], crls: [crl] },
      dss: { certs: [certificateDer(ca)] },
    });
    const [level] = await detectPadesLevels(await parsePdfBytes(pdf));
    expect(level.ltv?.revocationDataCoversSigner).toBe(false);
    expect(level.level).toBe(PadesLevel.B_T);
  });
});

describe('#12 validation time', () => {
  let expiredLeaf: TestIdentity;
  beforeAll(async () => {
    expiredLeaf = await createIdentity({
      commonName: 'rt expired leaf',
      issuer: ca,
      notBefore: ago(2 * YEAR),
      notAfter: ago(1 * YEAR),
    });
  });

  it('ignores a signingTime inside the validity period: current time is used', async () => {
    const report = await verifyOne(
      await createSignedPdf(expiredLeaf, {
        cms: { certificates: [ca], signingTime: ago(1.5 * YEAR) },
      }),
      { trustAnchorPaths: [caPemPath] },
    );
    expect(report.validationTime?.source).toBe('current_time');
    expect(report.trust.status).toBe(TrustStatus.UNTRUSTED);
    expect(report.cms?.signingTimeAttribute).toBeTruthy();
  });

  it('uses a verified signature timestamp', async () => {
    const genTime = ago(1.5 * YEAR);
    const report = await verifyOne(
      await createSignedPdf(expiredLeaf, {
        tsa,
        cms: { certificates: [ca], tsaGenTime: genTime },
      }),
      { trustAnchorPaths: [caPemPath] },
    );
    expect(report.validationTime).toEqual({
      time: genTime.toISOString(),
      source: 'signature_timestamp',
    });
    expect(report.trust.status).toBe(TrustStatus.TRUSTED);
  });

  it('does not use a timestamp whose TSA is untrusted when anchors are given', async () => {
    const strangerTsa = await createTestCa('rt stranger TSA');
    const report = await verifyOne(
      await createSignedPdf(expiredLeaf, {
        tsa: strangerTsa,
        cms: { certificates: [ca], tsaGenTime: ago(1.5 * YEAR) },
      }),
      { trustAnchorPaths: [caPemPath] },
    );
    expect(report.validationTime?.source).toBe('current_time');
  });

  it('falls back to the earliest covering document timestamp', () => {
    const sig = { byteRange: [0, 100, 200, 50] } as SignatureField;
    const later = new Date('2025-06-01T00:00:00Z');
    const earlier = new Date('2025-01-01T00:00:00Z');
    const notCovering = new Date('2024-01-01T00:00:00Z');
    const vt = chooseValidationTime(sig, null, false, [
      { coversUpTo: 400, genTime: later },
      { coversUpTo: 300, genTime: earlier },
      { coversUpTo: 240, genTime: notCovering },
    ]);
    expect(vt).toEqual({ time: earlier.toISOString(), source: 'document_timestamp' });
  });
});

describe('#13 revocation time and signed revocation data', () => {
  it('revoked after a proven signing time: revoked_after_validation_time, verdict valid', async () => {
    const crl = await createCrl(ca, [leaf.certificate.serialNumber], { revocationDate: ago(HOUR) });
    const report = await verifyOne(
      await createSignedPdf(leaf, {
        tsa,
        cms: { certificates: [ca], tsaGenTime: ago(2 * HOUR) },
        dss: { crls: [crl] },
      }),
    );
    expect(report.revocation?.status).toBe(RevocationStatus.REVOKED_AFTER_VALIDATION_TIME);
    expect(report.verdict).toBe(Verdict.VALID);

    const integrity = await analyzeIntegrity(await parsePdfBytes(await createSignedPdf(leaf)));
    const policy = evaluatePolicy(
      { signatures: [report], integrity, pades: [], conformance: null },
      'general',
    );
    expect(policy.firedRules.map((r) => r.ruleId)).toContain('POL-CAUTION-REVOKED-AFTER-SIGNING');
    expect(policy.firedRules.map((r) => r.ruleId)).not.toContain('POL-REJECT-REVOKED');
  });

  it('revoked before the timestamp: revoked, verdict indeterminate', async () => {
    const crl = await createCrl(ca, [leaf.certificate.serialNumber], {
      revocationDate: ago(3 * HOUR),
    });
    const report = await verifyOne(
      await createSignedPdf(leaf, {
        tsa,
        cms: { certificates: [ca], tsaGenTime: ago(2 * HOUR) },
        dss: { crls: [crl] },
      }),
    );
    expect(report.revocation?.status).toBe(RevocationStatus.REVOKED);
    expect(report.verdict).toBe(Verdict.INDETERMINATE);
  });

  it('a CRL that cannot be verified (issuer missing) gives unknown', async () => {
    const crl = await createCrl(ca, [leaf.certificate.serialNumber]);
    const report = await verifyOne(await createSignedPdf(leaf, { dss: { crls: [crl] } }));
    expect(report.revocation?.status).toBe(RevocationStatus.UNKNOWN);
    expect(report.revocation?.detail).toContain('NOT verified');
    expect(report.verdict).toBe(Verdict.VALID);
  });

  it('a CRL signed by another key gives unknown', async () => {
    const impostor = await createTestCa('rt CA');
    const forged = await createCrl(impostor, [leaf.certificate.serialNumber]);
    const report = await verifyOne(
      await createSignedPdf(leaf, { cms: { certificates: [ca] }, dss: { crls: [forged] } }),
    );
    expect(report.revocation?.status).toBe(RevocationStatus.UNKNOWN);
    expect(report.verdict).toBe(Verdict.VALID);
  });

  it('a verified GOOD keeps a note of an unverified "revoked" claim', async () => {
    const stranger = await createTestCa('rt stranger 2');
    const forged = await createOcspResponse({
      responder: ca,
      issuer: ca,
      subject: leaf,
      status: 'revoked',
      signingKey: stranger.privateKey,
    });
    const crl = await createCrl(ca, []);
    const report = await verifyOne(
      await createSignedPdf(leaf, {
        cms: { certificates: [ca] },
        dss: { ocsps: [forged], crls: [crl] },
      }),
    );
    expect(report.revocation?.status).toBe(RevocationStatus.GOOD);
    expect(report.revocation?.source).toBe('crl_embedded');
    expect(report.revocation?.detail).toContain(
      'unverified data claims the certificate is revoked',
    );
  });

  it('an expired CRL does not prove "good"', async () => {
    const crl = await createCrl(ca, [], { thisUpdate: ago(3 * HOUR), nextUpdate: ago(2 * HOUR) });
    const report = await verifyOne(
      await createSignedPdf(leaf, { cms: { certificates: [ca] }, dss: { crls: [crl] } }),
    );
    expect(report.revocation?.status).toBe(RevocationStatus.UNKNOWN);
    expect(report.revocation?.detail).toContain('expired');
  });

  it('OCSP: CA-signed good / revoked with time / forged / delegated responder', async () => {
    const run = async (ocsp: Uint8Array) =>
      (
        await verifyOne(
          await createSignedPdf(leaf, { cms: { certificates: [ca] }, dss: { ocsps: [ocsp] } }),
        )
      ).revocation;

    const good = await run(
      await createOcspResponse({ responder: ca, issuer: ca, subject: leaf, status: 'good' }),
    );
    expect(good?.status).toBe(RevocationStatus.GOOD);
    expect(good?.origin).toBe('dss');

    const revokedAt = ago(5 * HOUR);
    const revoked = await run(
      await createOcspResponse({
        responder: ca,
        issuer: ca,
        subject: leaf,
        status: 'revoked',
        revocationTime: revokedAt,
      }),
    );
    expect(revoked?.status).toBe(RevocationStatus.REVOKED);
    expect(
      Math.abs(new Date(revoked?.revocationTime ?? 0).getTime() - revokedAt.getTime()),
    ).toBeLessThan(1000);

    const stranger = await createTestCa('stranger');
    const forged = await run(
      await createOcspResponse({
        responder: ca,
        issuer: ca,
        subject: leaf,
        status: 'revoked',
        signingKey: stranger.privateKey,
      }),
    );
    expect(forged?.status).toBe(RevocationStatus.UNKNOWN);
    expect(forged?.detail).toContain('NOT verified');

    const delegate = await createIdentity({
      commonName: 'rt OCSP responder',
      issuer: ca,
      extKeyUsage: ['1.3.6.1.5.5.7.3.9'],
    });
    const delegated = await run(
      await createOcspResponse({ responder: delegate, issuer: ca, subject: leaf, status: 'good' }),
    );
    expect(delegated?.status).toBe(RevocationStatus.GOOD);

    const noEku = await createIdentity({ commonName: 'rt no-EKU responder', issuer: ca });
    const refused = await run(
      await createOcspResponse({ responder: noEku, issuer: ca, subject: leaf, status: 'good' }),
    );
    expect(refused?.status).toBe(RevocationStatus.UNKNOWN);
    expect(refused?.detail).toContain('OCSPSigning');
  });

  it('a revoked intermediate CA makes the chain untrusted', async () => {
    const inter = await createIdentity({ commonName: 'rt intermediate', issuer: ca, isCa: true });
    const leaf2 = await createIdentity({ commonName: 'rt leaf under intermediate', issuer: inter });
    const crlRoot = await createCrl(ca, [inter.certificate.serialNumber]);
    const report = await verifyOne(
      await createSignedPdf(leaf2, {
        cms: { certificates: [inter, ca] },
        dss: { crls: [crlRoot] },
      }),
      { trustAnchorPaths: [caPemPath] },
    );
    expect(report.trust.status).toBe(TrustStatus.UNTRUSTED);
    expect(report.trust.detail).toContain('Intermediate CA');
  });
});
