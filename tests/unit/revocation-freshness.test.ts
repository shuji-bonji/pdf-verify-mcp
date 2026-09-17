/**
 * v0.28.0 (#16): revocation freshness, signers of revocation data, trusted
 * OCSP responders, and per-intermediate-CA revocation results.
 */

import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RevocationMode, RevocationStatus, TrustStatus } from '../../src/constants.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { verifySignatures } from '../../src/services/verification-service.js';
import {
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
let dir: string;
let caPemPath: string;

beforeAll(async () => {
  ca = await createIdentity({ commonName: 'fr CA', isCa: true, notBefore: ago(10 * YEAR) });
  leaf = await createIdentity({ commonName: 'fr leaf', issuer: ca });
  tsa = await createIdentity({ commonName: 'fr TSA', issuer: ca, notBefore: ago(5 * YEAR) });
  dir = await mkdtemp(join(tmpdir(), 'pdf-verify-fr-'));
  caPemPath = join(dir, 'ca.pem');
  await writeFile(caPemPath, certificateToPem(ca));
});

async function verifyOne(pdf: Uint8Array, opts: Parameters<typeof verifySignatures>[1] = {}) {
  const [report] = await verifySignatures(await parsePdfBytes(pdf), opts);
  return report;
}

describe('freshness (thisUpdate vs validation time)', () => {
  let pdf: Uint8Array;
  beforeAll(async () => {
    // Validation time = TS genTime (now - 1 h); CRL issued 48 h before that.
    const crl = await createCrl(ca, [], { thisUpdate: ago(49 * HOUR) });
    pdf = await createSignedPdf(leaf, {
      tsa,
      cms: { certificates: [ca], tsaGenTime: ago(HOUR) },
      dss: { crls: [crl] },
    });
  });

  it('a CRL issued more than 24 h before the validation time gives unknown', async () => {
    const report = await verifyOne(pdf);
    expect(report.revocation?.status).toBe(RevocationStatus.UNKNOWN);
    expect(report.revocation?.detail).toContain('too old');
    expect(report.revocation?.thisUpdate).toBeTruthy();
  });

  it('revocation_freshness widens the window', async () => {
    const report = await verifyOne(pdf, { revocationFreshnessSeconds: 3 * 24 * 3600 });
    expect(report.revocation?.status).toBe(RevocationStatus.GOOD);
  });

  it('freshness 0 accepts data issued after the validation time', async () => {
    const crl = await createCrl(ca, [], { thisUpdate: ago(10 * 60 * 1000) });
    const report = await verifyOne(
      await createSignedPdf(leaf, {
        tsa,
        cms: { certificates: [ca], tsaGenTime: ago(HOUR) },
        dss: { crls: [crl] },
      }),
      { revocationFreshnessSeconds: 0 },
    );
    expect(report.revocation?.status).toBe(RevocationStatus.GOOD);
  });

  it('freshness does not hide a revocation', async () => {
    const crl = await createCrl(ca, [leaf.certificate.serialNumber], {
      thisUpdate: ago(100 * HOUR),
      revocationDate: ago(200 * HOUR),
    });
    const report = await verifyOne(
      await createSignedPdf(leaf, { cms: { certificates: [ca] }, dss: { crls: [crl] } }),
    );
    expect(report.revocation?.status).toBe(RevocationStatus.REVOKED);
  });
});

describe('signers of revocation data', () => {
  const pdfWith = (ocsp: Uint8Array, crls: Uint8Array[] = []) =>
    createSignedPdf(leaf, { cms: { certificates: [ca] }, dss: { ocsps: [ocsp], crls } });

  it('a delegated responder not valid at producedAt is refused', async () => {
    const expired = await createIdentity({
      commonName: 'fr expired responder',
      issuer: ca,
      extKeyUsage: ['1.3.6.1.5.5.7.3.9'],
      notBefore: ago(2 * YEAR),
      notAfter: ago(YEAR),
    });
    const ocsp = await createOcspResponse({
      responder: expired,
      issuer: ca,
      subject: leaf,
      status: 'good',
    });
    const report = await verifyOne(await pdfWith(ocsp));
    expect(report.revocation?.status).toBe(RevocationStatus.UNKNOWN);
    expect(report.revocation?.detail).toContain('not valid at producedAt');
  });

  it('a revoked delegated responder is refused unless it carries ocsp-nocheck', async () => {
    const plain = await createIdentity({
      commonName: 'fr revoked responder',
      issuer: ca,
      extKeyUsage: ['1.3.6.1.5.5.7.3.9'],
    });
    const noCheck = await createIdentity({
      commonName: 'fr nocheck responder',
      issuer: ca,
      extKeyUsage: ['1.3.6.1.5.5.7.3.9'],
      ocspNoCheck: true,
    });
    const crl = await createCrl(
      ca,
      [plain.certificate.serialNumber, noCheck.certificate.serialNumber],
      {
        revocationDate: ago(HOUR),
      },
    );

    const refused = await verifyOne(
      await pdfWith(
        await createOcspResponse({ responder: plain, issuer: ca, subject: leaf, status: 'good' }),
        [crl],
      ),
    );
    // The OCSP answer is refused; the CRL (which does not list the leaf) answers instead.
    expect(refused.revocation?.source).toBe('crl_embedded');

    const onlyOcsp = await verifyOne(
      await pdfWith(
        await createOcspResponse({ responder: plain, issuer: ca, subject: leaf, status: 'good' }),
      ),
    );
    expect(onlyOcsp.revocation?.status).toBe(RevocationStatus.GOOD);

    const accepted = await verifyOne(
      await pdfWith(
        await createOcspResponse({ responder: noCheck, issuer: ca, subject: leaf, status: 'good' }),
        [crl],
      ),
    );
    expect(accepted.revocation?.source).toBe('ocsp_embedded');
    expect(accepted.revocation?.status).toBe(RevocationStatus.GOOD);
  });

  it('a CRL whose issuer certificate was not valid at thisUpdate is refused', async () => {
    const youngCa = await createIdentity({ commonName: 'fr young CA', isCa: true });
    const youngLeaf = await createIdentity({ commonName: 'fr young leaf', issuer: youngCa });
    const crl = await createCrl(youngCa, [], { thisUpdate: ago(3 * 24 * HOUR) });
    const report = await verifyOne(
      await createSignedPdf(youngLeaf, { cms: { certificates: [youngCa] }, dss: { crls: [crl] } }),
      { revocationFreshnessSeconds: 10 * 24 * 3600 },
    );
    expect(report.revocation?.status).toBe(RevocationStatus.UNKNOWN);
    expect(report.revocation?.detail).toContain('not valid at thisUpdate');
  });

  it('trusted_ocsp_responders accepts a responder from another CA', async () => {
    const otherCa = await createTestCa('fr other CA');
    const outside = await createIdentity({ commonName: 'fr outside responder', issuer: otherCa });
    const ocsp = await createOcspResponse({
      responder: outside,
      issuer: ca,
      subject: leaf,
      status: 'good',
    });
    const pdf = await pdfWith(ocsp);

    const without = await verifyOne(pdf);
    expect(without.revocation?.status).toBe(RevocationStatus.UNKNOWN);

    const pem = join(dir, 'outside-responder.pem');
    await writeFile(pem, certificateToPem(outside));
    const withTrusted = await verifyOne(pdf, { trustedOcspResponderPaths: [pem] });
    expect(withTrusted.revocation?.status).toBe(RevocationStatus.GOOD);
  });
});

describe('trust.chainRevocation', () => {
  let server: Server;
  let baseUrl: string;
  let interCrl: Uint8Array | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/inter.crl' && interCrl) {
        res.writeHead(200, { 'Content-Type': 'application/pkix-crl' });
        res.end(Buffer.from(interCrl));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('no server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => {
    server?.close();
  });

  it('reports each intermediate CA, from embedded data', async () => {
    const inter = await createIdentity({ commonName: 'fr inter', issuer: ca, isCa: true });
    const leaf2 = await createIdentity({ commonName: 'fr leaf2', issuer: inter });
    const crl = await createCrl(ca, []);
    const report = await verifyOne(
      await createSignedPdf(leaf2, { cms: { certificates: [inter, ca] }, dss: { crls: [crl] } }),
      { trustAnchorPaths: [caPemPath] },
    );
    expect(report.trust.status).toBe(TrustStatus.TRUSTED);
    expect(report.trust.chainRevocation).toHaveLength(1);
    expect(report.trust.chainRevocation?.[0]).toMatchObject({
      subject: expect.stringContaining('fr inter'),
      status: RevocationStatus.GOOD,
      source: 'crl_embedded',
      origin: 'dss',
    });
  });

  it('online mode queries the intermediate CA endpoints', async () => {
    const inter = await createIdentity({
      commonName: 'fr inter online',
      issuer: ca,
      isCa: true,
      crlUrl: `${baseUrl}/inter.crl`,
    });
    const leaf3 = await createIdentity({ commonName: 'fr leaf3', issuer: inter });
    interCrl = await createCrl(ca, [inter.certificate.serialNumber]);
    const pdf = await createSignedPdf(leaf3, { cms: { certificates: [inter, ca] } });

    const embedded = await verifyOne(pdf, { trustAnchorPaths: [caPemPath] });
    expect(embedded.trust.status).toBe(TrustStatus.TRUSTED);
    expect(embedded.trust.chainRevocation?.[0].status).toBe(RevocationStatus.UNKNOWN);

    const online = await verifyOne(pdf, {
      trustAnchorPaths: [caPemPath],
      revocationMode: RevocationMode.ONLINE,
    });
    expect(online.trust.status).toBe(TrustStatus.UNTRUSTED);
    expect(online.trust.chainRevocation?.[0]).toMatchObject({
      status: RevocationStatus.REVOKED,
      source: 'crl_online',
    });
  });

  it('is null when check_revocation is none', async () => {
    const inter = await createIdentity({ commonName: 'fr inter none', issuer: ca, isCa: true });
    const leaf4 = await createIdentity({ commonName: 'fr leaf4', issuer: inter });
    const report = await verifyOne(
      await createSignedPdf(leaf4, { cms: { certificates: [inter, ca] } }),
      { trustAnchorPaths: [caPemPath], revocationMode: RevocationMode.NONE },
    );
    expect(report.trust.status).toBe(TrustStatus.TRUSTED);
    expect(report.trust.chainRevocation).toBeNull();
  });
});
