/**
 * Trust chain evaluation and revocation checking (v0.2).
 *
 * - Chain: pkijs CertificateChainValidationEngine against user trust anchors
 * - Revocation, embedded: OCSP responses / CRLs from the DSS and CMS payload
 * - Revocation, online: OCSP via the certificate's AIA extension, CRL via
 *   CRLDistributionPoints (opt-in, check_revocation='online')
 */

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import {
  ASN1_LARGE_STRUCTURE_LIMITS,
  REVOCATION_FETCH_TIMEOUT,
  RevocationStatus,
  TrustStatus,
  X509_OID,
} from '../constants.js';
import type { RevocationResult, TrustResult } from '../types.js';
import { logger } from '../utils/logger.js';

const CONTEXT = 'revocation';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function fromBerOrNull<T>(bytes: Uint8Array, factory: (schema: asn1js.AsnType) => T): T | null {
  try {
    // Raised limits: real-world CRLs blow past asn1js's default maxNodes.
    const asn1 = asn1js.fromBER(toArrayBuffer(bytes), ASN1_LARGE_STRUCTURE_LIMITS);
    if (asn1.offset === -1) return null;
    return factory(asn1.result);
  } catch {
    return null;
  }
}

/** Parse DER OCSP responses (full OCSPResponse or bare BasicOCSPResponse) */
export function parseOcspResponses(items: Uint8Array[]): pkijs.BasicOCSPResponse[] {
  const results: pkijs.BasicOCSPResponse[] = [];
  for (const der of items) {
    const full = fromBerOrNull(der, (s) => new pkijs.OCSPResponse({ schema: s }));
    if (full?.responseBytes) {
      const basic = fromBerOrNull(
        new Uint8Array(full.responseBytes.response.valueBlock.valueHexView),
        (s) => new pkijs.BasicOCSPResponse({ schema: s }),
      );
      if (basic) {
        results.push(basic);
        continue;
      }
    }
    const bare = fromBerOrNull(der, (s) => new pkijs.BasicOCSPResponse({ schema: s }));
    if (bare) results.push(bare);
  }
  return results;
}

/** Parse DER CRLs */
export function parseCrls(items: Uint8Array[]): pkijs.CertificateRevocationList[] {
  const results: pkijs.CertificateRevocationList[] = [];
  for (const der of items) {
    const crl = fromBerOrNull(der, (s) => new pkijs.CertificateRevocationList({ schema: s }));
    if (crl) results.push(crl);
  }
  return results;
}

/** Parse DER certificates */
export function parseCertificates(items: Uint8Array[]): pkijs.Certificate[] {
  const results: pkijs.Certificate[] = [];
  for (const der of items) {
    const cert = fromBerOrNull(der, (s) => new pkijs.Certificate({ schema: s }));
    if (cert) results.push(cert);
  }
  return results;
}

export interface ChainEvaluationInput {
  signerCert: pkijs.Certificate;
  /** All certificates available for chain building (CMS + DSS) */
  availableCerts: pkijs.Certificate[];
  trustAnchors: pkijs.Certificate[];
  /** Validation reference time (signing time when known) */
  checkDate: Date;
  crls?: pkijs.CertificateRevocationList[];
  ocsps?: pkijs.BasicOCSPResponse[];
}

/** Evaluate the signer's chain against the given trust anchors */
export async function evaluateTrust(input: ChainEvaluationInput): Promise<TrustResult> {
  if (input.trustAnchors.length === 0) {
    return {
      status: TrustStatus.NOT_EVALUATED,
      detail: 'No trust anchors provided (trust_anchors parameter or PDF_VERIFY_TRUST_ANCHORS).',
      certificatePath: null,
    };
  }

  try {
    const engine = new pkijs.CertificateChainValidationEngine({
      trustedCerts: input.trustAnchors,
      certs: [...input.availableCerts.filter((c) => c !== input.signerCert), input.signerCert],
      crls: input.crls ?? [],
      ocsps: input.ocsps ?? [],
      checkDate: input.checkDate,
    });
    const result = await engine.verify();
    const path =
      result.certificatePath?.map((c) =>
        c.subject.typesAndValues.map((tv) => `${tv.type}=${tv.value.valueBlock.value}`).join(','),
      ) ?? null;
    return {
      status: result.result ? TrustStatus.TRUSTED : TrustStatus.UNTRUSTED,
      detail: result.result
        ? `Chain validated against ${input.trustAnchors.length} trust anchor(s) at ${input.checkDate.toISOString()}`
        : `Chain validation failed: ${result.resultMessage || `code ${result.resultCode}`}`,
      certificatePath: path,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(CONTEXT, `chain evaluation error: ${message}`);
    return {
      status: TrustStatus.UNTRUSTED,
      detail: `Chain validation error: ${message}`,
      certificatePath: null,
    };
  }
}

function findIssuerCert(
  cert: pkijs.Certificate,
  candidates: pkijs.Certificate[],
): pkijs.Certificate | null {
  const issuerName = cert.issuer.typesAndValues
    .map((tv) => `${tv.type}=${tv.value.valueBlock.value}`)
    .join(',');
  return (
    candidates.find(
      (c) =>
        c.subject.typesAndValues
          .map((tv) => `${tv.type}=${tv.value.valueBlock.value}`)
          .join(',') === issuerName,
    ) ?? null
  );
}

/** Extract the OCSP responder URL from the AIA extension */
export function extractOcspUrl(cert: pkijs.Certificate): string | null {
  const ext = cert.extensions?.find((e) => e.extnID === X509_OID.AUTHORITY_INFO_ACCESS);
  const infoAccess = ext?.parsedValue as pkijs.InfoAccess | undefined;
  if (!infoAccess) return null;
  for (const ad of infoAccess.accessDescriptions) {
    if (ad.accessMethod === X509_OID.ACCESS_METHOD_OCSP && ad.accessLocation.type === 6) {
      return String(ad.accessLocation.value);
    }
  }
  return null;
}

/** Extract CRL distribution point URLs */
export function extractCrlUrls(cert: pkijs.Certificate): string[] {
  const ext = cert.extensions?.find((e) => e.extnID === X509_OID.CRL_DISTRIBUTION_POINTS);
  const cdp = ext?.parsedValue as pkijs.CRLDistributionPoints | undefined;
  if (!cdp) return [];
  const urls: string[] = [];
  for (const dp of cdp.distributionPoints) {
    const point = dp.distributionPoint;
    if (Array.isArray(point)) {
      for (const name of point) {
        if (name.type === 6) urls.push(String(name.value));
      }
    }
  }
  return urls.filter((u) => u.startsWith('http'));
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REVOCATION_FETCH_TIMEOUT) });
}

/** Query an OCSP responder for the certificate's status */
async function fetchOcspStatus(
  cert: pkijs.Certificate,
  issuer: pkijs.Certificate,
  url: string,
): Promise<{ status: RevocationStatus; detail: string } | null> {
  try {
    const request = new pkijs.OCSPRequest();
    await request.createForCertificate(cert, { hashAlgorithm: 'SHA-1', issuerCertificate: issuer });
    const body = request.toSchema(true).toBER(false);
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/ocsp-request' },
      body: Buffer.from(body),
    });
    if (!response.ok)
      return { status: RevocationStatus.UNKNOWN, detail: `OCSP HTTP ${response.status}` };
    const der = new Uint8Array(await response.arrayBuffer());
    const ocspResponse = fromBerOrNull(der, (s) => new pkijs.OCSPResponse({ schema: s }));
    if (!ocspResponse)
      return { status: RevocationStatus.UNKNOWN, detail: 'OCSP response unparseable' };
    const { isForCertificate, status } = await ocspResponse.getCertificateStatus(cert, issuer);
    if (!isForCertificate)
      return { status: RevocationStatus.UNKNOWN, detail: 'OCSP response not for this certificate' };
    return {
      status:
        status === 0
          ? RevocationStatus.GOOD
          : status === 1
            ? RevocationStatus.REVOKED
            : RevocationStatus.UNKNOWN,
      detail: `OCSP responder ${url}`,
    };
  } catch (error) {
    logger.debug(CONTEXT, `OCSP fetch failed: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/** Download and check a CRL */
async function fetchCrlStatus(
  cert: pkijs.Certificate,
  url: string,
): Promise<{ status: RevocationStatus; detail: string } | null> {
  try {
    const response = await fetchWithTimeout(url, { method: 'GET' });
    if (!response.ok) return null;
    const der = new Uint8Array(await response.arrayBuffer());
    const crl = parseCrls([der])[0];
    if (!crl) return null;
    return {
      status: crlStatusFor(cert, crl),
      detail: `CRL from ${url}`,
    };
  } catch (error) {
    logger.debug(CONTEXT, `CRL fetch failed: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

function serialHex(value: asn1js.Integer): string {
  return Array.from(new Uint8Array(value.valueBlock.valueHexView), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

function crlStatusFor(
  cert: pkijs.Certificate,
  crl: pkijs.CertificateRevocationList,
): RevocationStatus {
  const target = serialHex(cert.serialNumber);
  const revoked = crl.revokedCertificates?.some((rc) => serialHex(rc.userCertificate) === target);
  return revoked ? RevocationStatus.REVOKED : RevocationStatus.GOOD;
}

export interface RevocationCheckInput {
  signerCert: pkijs.Certificate;
  availableCerts: pkijs.Certificate[];
  embeddedOcsps: pkijs.BasicOCSPResponse[];
  embeddedCrls: pkijs.CertificateRevocationList[];
  /** Allow network access to OCSP responders / CRL distribution points */
  online: boolean;
}

/** Determine the signer certificate's revocation status */
export async function checkRevocation(input: RevocationCheckInput): Promise<RevocationResult> {
  const { signerCert } = input;
  const issuer = findIssuerCert(signerCert, input.availableCerts);

  // 1. Embedded OCSP responses
  if (issuer) {
    for (const basic of input.embeddedOcsps) {
      try {
        const { isForCertificate, status } = await basic.getCertificateStatus(signerCert, issuer);
        if (isForCertificate) {
          return {
            status:
              status === 0
                ? RevocationStatus.GOOD
                : status === 1
                  ? RevocationStatus.REVOKED
                  : RevocationStatus.UNKNOWN,
            source: 'ocsp_embedded',
            detail: 'Embedded OCSP response (DSS/CMS)',
          };
        }
      } catch {
        // try next response
      }
    }
  }

  // 2. Embedded CRLs (match issuer by name)
  for (const crl of input.embeddedCrls) {
    const crlIssuer = crl.issuer.typesAndValues
      .map((tv) => `${tv.type}=${tv.value.valueBlock.value}`)
      .join(',');
    const certIssuer = signerCert.issuer.typesAndValues
      .map((tv) => `${tv.type}=${tv.value.valueBlock.value}`)
      .join(',');
    if (crlIssuer !== certIssuer) continue;
    return {
      status: crlStatusFor(signerCert, crl),
      source: 'crl_embedded',
      detail: 'Embedded CRL (DSS/CMS)',
    };
  }

  // 3. Online (opt-in)
  if (input.online) {
    const ocspUrl = extractOcspUrl(signerCert);
    if (ocspUrl && issuer) {
      const result = await fetchOcspStatus(signerCert, issuer, ocspUrl);
      if (result) return { ...result, source: 'ocsp_online' };
    }
    for (const url of extractCrlUrls(signerCert)) {
      const result = await fetchCrlStatus(signerCert, url);
      if (result) return { ...result, source: 'crl_online' };
    }
    return {
      status: RevocationStatus.UNKNOWN,
      source: null,
      detail:
        'No usable revocation source (embedded data absent; online endpoints unreachable or undeclared)',
    };
  }

  return {
    status: RevocationStatus.UNKNOWN,
    source: null,
    detail:
      'No embedded revocation information found (use check_revocation="online" to query OCSP/CRL endpoints)',
  };
}
