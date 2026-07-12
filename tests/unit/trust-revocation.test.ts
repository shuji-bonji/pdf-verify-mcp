/**
 * v0.2: trust chain evaluation, revocation checking, TST verification,
 * and content-level LTV validation.
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
import { extractCrlUrls, extractOcspUrl } from '../../src/services/revocation.js';
import { detectPadesLevels, verifySignatures } from '../../src/services/verification-service.js';
import {
  certificateToPem,
  createCrl,
  createIdentity,
  createSignedPdf,
  createTestCa,
  type TestIdentity,
} from '../helpers/signed-pdf.js';

let ca: TestIdentity;
let leaf: TestIdentity;
let otherCa: TestIdentity;
let caPemPath: string;
let otherCaPemPath: string;

beforeAll(async () => {
  ca = await createTestCa('pdf-verify test CA');
  leaf = await createIdentity({ commonName: 'pdf-verify leaf signer', issuer: ca });
  otherCa = await createTestCa('unrelated CA');

  const dir = await mkdtemp(join(tmpdir(), 'pdf-verify-anchors-'));
  caPemPath = join(dir, 'test-ca.pem');
  otherCaPemPath = join(dir, 'other-ca.pem');
  await writeFile(caPemPath, certificateToPem(ca));
  await writeFile(otherCaPemPath, certificateToPem(otherCa));
});

describe('trust chain evaluation', () => {
  it('reports trusted when the issuing CA is a trust anchor', async () => {
    const pdf = await createSignedPdf(leaf, {
      dss: { certs: [new Uint8Array(ca.certificate.toSchema(true).toBER(false))] },
    });
    const parsed = await parsePdfBytes(pdf);
    const [report] = await verifySignatures(parsed, { trustAnchorPaths: [caPemPath] });

    expect(report.verdict).toBe(Verdict.VALID);
    expect(report.trust.status).toBe(TrustStatus.TRUSTED);
    expect(report.trust.certificatePath?.length).toBeGreaterThan(0);
  });

  it('reports untrusted against an unrelated anchor', async () => {
    const pdf = await createSignedPdf(leaf, {
      dss: { certs: [new Uint8Array(ca.certificate.toSchema(true).toBER(false))] },
    });
    const parsed = await parsePdfBytes(pdf);
    const [report] = await verifySignatures(parsed, { trustAnchorPaths: [otherCaPemPath] });

    expect(report.trust.status).toBe(TrustStatus.UNTRUSTED);
  });

  it('reports not_evaluated without anchors', async () => {
    const pdf = await createSignedPdf(leaf);
    const parsed = await parsePdfBytes(pdf);
    const [report] = await verifySignatures(parsed);

    expect(report.trust.status).toBe(TrustStatus.NOT_EVALUATED);
  });
});

describe('revocation checking (embedded)', () => {
  it('good when an embedded CRL does not list the signer', async () => {
    const crl = await createCrl(ca, []);
    const pdf = await createSignedPdf(leaf, { dss: { crls: [crl] } });
    const parsed = await parsePdfBytes(pdf);
    const [report] = await verifySignatures(parsed);

    expect(report.revocation?.status).toBe(RevocationStatus.GOOD);
    expect(report.revocation?.source).toBe('crl_embedded');
  });

  it('revoked (and verdict invalid) when the embedded CRL lists the signer', async () => {
    const crl = await createCrl(ca, [leaf.certificate.serialNumber]);
    const pdf = await createSignedPdf(leaf, { dss: { crls: [crl] } });
    const parsed = await parsePdfBytes(pdf);
    const [report] = await verifySignatures(parsed);

    expect(report.revocation?.status).toBe(RevocationStatus.REVOKED);
    expect(report.verdict).toBe(Verdict.INVALID);
  });

  it('unknown when no revocation data exists and mode is embedded', async () => {
    const pdf = await createSignedPdf(leaf);
    const parsed = await parsePdfBytes(pdf);
    const [report] = await verifySignatures(parsed, {
      revocationMode: RevocationMode.EMBEDDED,
    });

    expect(report.revocation?.status).toBe(RevocationStatus.UNKNOWN);
  });
});

describe('RFC 3161 signature timestamp', () => {
  it('verifies a valid TST over the signature value', async () => {
    const tsa = await createIdentity({ commonName: 'pdf-verify test TSA', issuer: ca });
    const pdf = await createSignedPdf(leaf, { tsa });
    const parsed = await parsePdfBytes(pdf);
    const [report] = await verifySignatures(parsed);

    const ts = report.cms?.signatureTimestamp;
    expect(ts).toBeTruthy();
    expect(ts?.imprintMatches).toBe(true);
    expect(ts?.signatureVerified).toBe(true);
    expect(ts?.tsaSubject).toContain('pdf-verify test TSA');
    expect(ts?.genTime).toBeTruthy();
  });
});

describe('content-level LTV (detect_pades_level)', () => {
  it('B-LT requires DSS revocation data that covers the signer', async () => {
    const tsa = await createIdentity({ commonName: 'LTV TSA', issuer: ca });
    const crl = await createCrl(ca, []);
    const pdf = await createSignedPdf(leaf, {
      tsa,
      dss: {
        certs: [new Uint8Array(ca.certificate.toSchema(true).toBER(false))],
        crls: [crl],
      },
    });
    const parsed = await parsePdfBytes(pdf);
    const [report] = await detectPadesLevels(parsed);

    expect(report.level).toBe(PadesLevel.B_LT);
    expect(report.ltv?.revocationDataCoversSigner).toBe(true);
    expect(report.ltv?.dssCrlCount).toBe(1);
  });

  it('caps at B-T when DSS lacks usable revocation data for the signer', async () => {
    const tsa = await createIdentity({ commonName: 'LTV TSA 2', issuer: ca });
    const unrelatedCrl = await createCrl(otherCa, []);
    const pdf = await createSignedPdf(leaf, {
      tsa,
      dss: { crls: [unrelatedCrl] },
    });
    const parsed = await parsePdfBytes(pdf);
    const [report] = await detectPadesLevels(parsed);

    expect(report.level).toBe(PadesLevel.B_T);
    expect(report.ltv?.revocationDataCoversSigner).toBe(false);
  });
});

describe('online endpoint extraction', () => {
  it('extracts OCSP and CRL URLs from certificate extensions', async () => {
    const certWithUrls = await createIdentity({
      commonName: 'with-urls',
      issuer: ca,
      ocspUrl: 'http://ocsp.example.test/',
      crlUrl: 'http://crl.example.test/ca.crl',
    });
    expect(extractOcspUrl(certWithUrls.certificate)).toBe('http://ocsp.example.test/');
    expect(extractCrlUrls(certWithUrls.certificate)).toEqual(['http://crl.example.test/ca.crl']);
  });
});
