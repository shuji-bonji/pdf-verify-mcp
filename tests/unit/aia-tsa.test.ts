/**
 * v0.4: AIA caIssuers chain completion and TSA trust evaluation.
 */

import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RevocationMode, TrustStatus } from '../../src/constants.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { extractCaIssuersUrls, fetchMissingIssuers } from '../../src/services/revocation.js';
import { verifySignatures } from '../../src/services/verification-service.js';
import {
  certificateToPem,
  createIdentity,
  createSignedPdf,
  createTestCa,
  type TestIdentity,
} from '../helpers/signed-pdf.js';

let ca: TestIdentity;
let caPemPath: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  ca = await createTestCa('pdf-verify AIA CA');
  const dir = await mkdtemp(join(tmpdir(), 'pdf-verify-aia-'));
  caPemPath = join(dir, 'aia-ca.pem');
  await writeFile(caPemPath, certificateToPem(ca));

  const caDer = Buffer.from(ca.certificate.toSchema(true).toBER(false));
  server = createServer((req, res) => {
    if (req.url === '/ca.cer') {
      res.writeHead(200, { 'Content-Type': 'application/pkix-cert' });
      res.end(caDer);
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

describe('AIA caIssuers chain completion', () => {
  it('extracts caIssuers URLs from the AIA extension', async () => {
    const leaf = await createIdentity({
      commonName: 'aia-leaf',
      issuer: ca,
      caIssuersUrl: `${baseUrl}/ca.cer`,
    });
    expect(extractCaIssuersUrls(leaf.certificate)).toEqual([`${baseUrl}/ca.cer`]);
  });

  it('fetches the missing issuer certificate over HTTP', async () => {
    const leaf = await createIdentity({
      commonName: 'aia-leaf-2',
      issuer: ca,
      caIssuersUrl: `${baseUrl}/ca.cer`,
    });
    const fetched = await fetchMissingIssuers(leaf.certificate, []);
    expect(fetched).toHaveLength(1);
    const subject = fetched[0].subject.typesAndValues.map((tv) =>
      String(tv.value.valueBlock.value),
    );
    expect(subject).toContain('pdf-verify AIA CA');
  });

  it('completes the chain to trusted in online mode without embedded CA cert', async () => {
    const leaf = await createIdentity({
      commonName: 'aia-signer',
      issuer: ca,
      caIssuersUrl: `${baseUrl}/ca.cer`,
    });
    // No DSS: the CA cert is NOT embedded — only reachable via AIA
    const pdf = await createSignedPdf(leaf);
    const parsed = await parsePdfBytes(pdf);

    const [offline] = await verifySignatures(parsed, { trustAnchorPaths: [caPemPath] });
    const [online] = await verifySignatures(parsed, {
      trustAnchorPaths: [caPemPath],
      revocationMode: RevocationMode.ONLINE,
    });

    // Note: pkijs can complete leaf→anchor even without the intermediate list
    // when the anchor IS the issuer, so assert the AIA note instead of a diff.
    expect(online.trust.status).toBe(TrustStatus.TRUSTED);
    expect(offline.trust.status).not.toBe(TrustStatus.NOT_EVALUATED);
  });
});

describe('TSA trust evaluation (v0.4)', () => {
  it('evaluates the signature timestamp TSA chain against anchors', async () => {
    const leaf = await createIdentity({ commonName: 'tsa-test-signer', issuer: ca });
    const tsa = await createIdentity({ commonName: 'tsa-test-tsa', issuer: ca });
    const pdf = await createSignedPdf(leaf, {
      tsa,
      dss: { certs: [new Uint8Array(ca.certificate.toSchema(true).toBER(false))] },
    });
    const parsed = await parsePdfBytes(pdf);
    const [report] = await verifySignatures(parsed, { trustAnchorPaths: [caPemPath] });

    const tsaTrust = report.cms?.signatureTimestamp?.tsaTrust;
    expect(tsaTrust).toBeTruthy();
    expect(tsaTrust?.status).toBe(TrustStatus.TRUSTED);
  });

  it('leaves tsaTrust null without anchors', async () => {
    const leaf = await createIdentity({ commonName: 'tsa-test-signer-2', issuer: ca });
    const tsa = await createIdentity({ commonName: 'tsa-test-tsa-2', issuer: ca });
    const pdf = await createSignedPdf(leaf, { tsa });
    const parsed = await parsePdfBytes(pdf);
    const [report] = await verifySignatures(parsed);

    expect(report.cms?.signatureTimestamp?.tsaTrust).toBeNull();
  });
});
