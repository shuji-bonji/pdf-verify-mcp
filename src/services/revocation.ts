/**
 * Trust chain evaluation and revocation checking (v0.2).
 *
 * - Chain: pkijs CertificateChainValidationEngine against user trust anchors
 * - Revocation, embedded: OCSP responses / CRLs from the DSS and CMS payload
 * - Revocation, online: OCSP via the certificate's AIA extension, CRL via
 *   CRLDistributionPoints (opt-in, check_revocation='online')
 */

import { createHash } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import {
  AIA_MAX_CHAIN_DEPTH,
  ASN1_LARGE_STRUCTURE_LIMITS,
  OID,
  REVOCATION_FETCH_TIMEOUT,
  RevocationStatus,
  TrustStatus,
  X509_OID,
} from '../constants.js';
import type { RevocationOrigin, RevocationResult, TrustResult } from '../types.js';
import { logger } from '../utils/logger.js';
import { canonicalName, formatRdn } from '../utils/rdn.js';

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
  /** Validation time (see ValidationTime) */
  checkDate: Date;
  /**
   * Embedded revocation data for the CA certificates in the path (v0.27.0).
   * The signer's own status is reported separately by checkRevocation.
   */
  ocsps?: EmbeddedOcsp[];
  crls?: EmbeddedCrl[];
  /** True when checkDate is proven by a verified timestamp */
  checkDateProven?: boolean;
}

/**
 * Evaluate the signer's chain against the given trust anchors.
 *
 * v0.27.0: revocation is no longer handed to pkijs's chain engine. pkijs
 * treats any listed certificate as revoked regardless of the revocation date,
 * and refuses the whole path when some certificate has no revocation data.
 * The path is built and time-checked by pkijs; revocation of intermediate CA
 * certificates is checked here with the same rules as the signer's
 * (ISO 32000-2 §12.8.3.4.6).
 */
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
      checkDate: input.checkDate,
    });
    const result = await engine.verify();
    const pathCerts = result.certificatePath ?? [];
    const path = result.certificatePath?.map((c) => formatRdn(c.subject)) ?? null;
    if (!result.result) {
      return {
        status: TrustStatus.UNTRUSTED,
        detail: `Chain validation failed: ${result.resultMessage || `code ${result.resultCode}`}`,
        certificatePath: path,
      };
    }

    // Intermediate CAs: path[0] is the signer, the last element the anchor.
    const caNotes: string[] = [];
    for (let i = 1; i < pathCerts.length - 1; i++) {
      const ca = pathCerts[i];
      const status = await checkRevocation({
        signerCert: ca,
        availableCerts: pathCerts,
        embeddedOcsps: input.ocsps ?? [],
        embeddedCrls: input.crls ?? [],
        online: false,
        validationTime: input.checkDate,
      });
      if (status.status !== RevocationStatus.REVOKED) continue;
      const revokedAt = status.revocationTime ? new Date(status.revocationTime) : null;
      if (input.checkDateProven && revokedAt && revokedAt > input.checkDate) {
        caNotes.push(
          `intermediate CA ${formatRdn(ca.subject)} was revoked at ${status.revocationTime}, after the validation time`,
        );
        continue;
      }
      return {
        status: TrustStatus.UNTRUSTED,
        detail: `Intermediate CA ${formatRdn(ca.subject)} is revoked${status.revocationTime ? ` (at ${status.revocationTime})` : ''} and no timestamp proves the signature predates it`,
        certificatePath: path,
      };
    }

    return {
      status: TrustStatus.TRUSTED,
      detail: `Chain validated against ${input.trustAnchors.length} trust anchor(s) at ${input.checkDate.toISOString()}${caNotes.length > 0 ? `; ${caNotes.join('; ')}` : ''}`,
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
  const issuer = canonicalName(cert.issuer);
  return candidates.find((c) => canonicalName(c.subject) === issuer) ?? null;
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

/** Extract caIssuers URLs from the AIA extension (v0.4) */
export function extractCaIssuersUrls(cert: pkijs.Certificate): string[] {
  const ext = cert.extensions?.find((e) => e.extnID === X509_OID.AUTHORITY_INFO_ACCESS);
  const infoAccess = ext?.parsedValue as pkijs.InfoAccess | undefined;
  if (!infoAccess) return [];
  const urls: string[] = [];
  for (const ad of infoAccess.accessDescriptions) {
    if (ad.accessMethod === X509_OID.ACCESS_METHOD_CA_ISSUERS && ad.accessLocation.type === 6) {
      urls.push(String(ad.accessLocation.value));
    }
  }
  return urls.filter((u) => u.startsWith('http'));
}

/** Parse a caIssuers payload: a bare DER certificate or a PKCS#7 bundle */
function parseCaIssuersPayload(der: Uint8Array): pkijs.Certificate[] {
  const single = fromBerOrNull(der, (s) => new pkijs.Certificate({ schema: s }));
  if (single) return [single];
  const contentInfo = fromBerOrNull(der, (s) => new pkijs.ContentInfo({ schema: s }));
  if (contentInfo?.contentType === OID.SIGNED_DATA) {
    try {
      const signedData = new pkijs.SignedData({ schema: contentInfo.content });
      return (signedData.certificates ?? []).filter(
        (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
      );
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Fetch missing issuer certificates via the AIA caIssuers access method (v0.4).
 * Walks up the chain until an issuer is already available, the certificate is
 * self-signed, or the depth limit is reached. Network access is the caller's
 * decision (only invoked in online revocation mode).
 *
 * @returns The certificates fetched (possibly empty)
 */
export async function fetchMissingIssuers(
  leaf: pkijs.Certificate,
  available: pkijs.Certificate[],
  maxDepth = AIA_MAX_CHAIN_DEPTH,
): Promise<pkijs.Certificate[]> {
  const fetched: pkijs.Certificate[] = [];
  const known = [...available];
  let current = leaf;

  for (let depth = 0; depth < maxDepth; depth++) {
    // Self-signed: top of the chain
    if (canonicalName(current.subject) === canonicalName(current.issuer)) break;
    // Issuer already available (embedded or previously fetched)
    const issuerOfCurrent = canonicalName(current.issuer);
    const existing = known.find((c) => canonicalName(c.subject) === issuerOfCurrent);
    if (existing) {
      current = existing;
      continue;
    }

    const urls = extractCaIssuersUrls(current);
    if (urls.length === 0) break;

    let found: pkijs.Certificate | null = null;
    for (const url of urls) {
      try {
        const response = await fetchWithTimeout(url, { method: 'GET' });
        if (!response.ok) continue;
        const der = new Uint8Array(await response.arrayBuffer());
        const certs = parseCaIssuersPayload(der);
        const issuer = certs.find((c) => canonicalName(c.subject) === issuerOfCurrent);
        if (issuer) {
          found = issuer;
          // Keep any extra chain certificates from a PKCS#7 bundle too
          for (const cert of certs) {
            if (!known.some((k) => canonicalName(k.subject) === canonicalName(cert.subject))) {
              known.push(cert);
              fetched.push(cert);
            }
          }
          break;
        }
      } catch (error) {
        logger.debug(
          CONTEXT,
          `caIssuers fetch failed (${url}): ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    if (!found) break;
    current = found;
  }

  return fetched;
}

/** Embedded OCSP response, tagged with where it sits in the PDF */
export interface EmbeddedOcsp {
  response: pkijs.BasicOCSPResponse;
  origin: RevocationOrigin;
}

/** Embedded CRL, tagged with where it sits in the PDF */
export interface EmbeddedCrl {
  crl: pkijs.CertificateRevocationList;
  origin: RevocationOrigin;
}

/** Tag parsed items with their origin */
export function tagOcsps(
  items: pkijs.BasicOCSPResponse[],
  origin: RevocationOrigin,
): EmbeddedOcsp[] {
  return items.map((response) => ({ response, origin }));
}

/** Tag parsed items with their origin */
export function tagCrls(
  items: pkijs.CertificateRevocationList[],
  origin: RevocationOrigin,
): EmbeddedCrl[] {
  return items.map((crl) => ({ crl, origin }));
}

/**
 * What one CRL or OCSP response says about one certificate.
 *
 * `verified` is false when the CRL / response signature could not be checked
 * against the issuer (or a delegated OCSP responder). An unverified statement
 * never becomes GOOD or REVOKED: a REVOKED status can turn a verdict, so it
 * must come from data we checked (v0.27.0, #13).
 */
interface StatusFinding {
  status: RevocationStatus.GOOD | RevocationStatus.REVOKED | RevocationStatus.UNKNOWN;
  revocationTime: Date | null;
  detail: string;
  /** UNKNOWN only: the unverified data itself says "revoked" */
  claimsRevoked?: boolean;
}

function serialHex(value: asn1js.Integer): string {
  return Array.from(new Uint8Array(value.valueBlock.valueHexView), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

function sameCertificate(a: pkijs.Certificate, b: pkijs.Certificate): boolean {
  return (
    canonicalName(a.subject) === canonicalName(b.subject) &&
    serialHex(a.serialNumber) === serialHex(b.serialNumber)
  );
}

function hasOcspSigningEku(cert: pkijs.Certificate): boolean {
  const ext = cert.extensions?.find((e) => e.extnID === X509_OID.EXTENDED_KEY_USAGE);
  const eku = ext?.parsedValue as pkijs.ExtKeyUsage | undefined;
  return eku?.keyPurposes?.includes(X509_OID.KP_OCSP_SIGNING) ?? false;
}

function sha1Hex(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/**
 * Verify a BasicOCSPResponse signature (RFC 6960 §4.2.2.2): the responder is
 * the issuing CA itself, or a delegate whose certificate is signed by that CA
 * and carries id-kp-OCSPSigning.
 */
async function verifyOcspResponse(
  basic: pkijs.BasicOCSPResponse,
  issuer: pkijs.Certificate,
): Promise<{ verified: boolean; reason: string | null }> {
  try {
    const rid = basic.tbsResponseData.responderID;
    const candidates = [issuer, ...(basic.certs ?? [])];
    let responder: pkijs.Certificate | null = null;
    if (rid instanceof pkijs.RelativeDistinguishedNames) {
      responder = candidates.find((c) => c.subject.isEqual(rid)) ?? null;
    } else if (rid instanceof asn1js.OctetString) {
      const want = Buffer.from(rid.valueBlock.valueHexView).toString('hex');
      for (const c of candidates) {
        const keyHash = sha1Hex(
          new Uint8Array(c.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView),
        );
        if (keyHash === want) {
          responder = c;
          break;
        }
      }
    }
    if (!responder) return { verified: false, reason: 'responder certificate not found' };

    if (!sameCertificate(responder, issuer)) {
      const signedByIssuer = await responder.verify(issuer).catch(() => false);
      if (!signedByIssuer) {
        return { verified: false, reason: 'delegated responder is not signed by the issuer' };
      }
      if (!hasOcspSigningEku(responder)) {
        return { verified: false, reason: 'delegated responder lacks id-kp-OCSPSigning' };
      }
    }

    const ok = await pkijs
      .getCrypto(true)
      .verifyWithPublicKey(
        toArrayBuffer(basic.tbsResponseData.tbsView),
        basic.signature,
        responder.subjectPublicKeyInfo,
        basic.signatureAlgorithm,
      );
    return ok
      ? { verified: true, reason: null }
      : { verified: false, reason: 'signature verification failed' };
  } catch (error) {
    return {
      verified: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The revocationTime of a revoked SingleResponse (RevokedInfo [1]) */
function ocspRevocationTime(single: pkijs.SingleResponse): Date | null {
  try {
    const status = single.certStatus as asn1js.Constructed;
    const first = status.valueBlock.value[0] as asn1js.GeneralizedTime | undefined;
    return first ? first.toDate() : null;
  } catch {
    return null;
  }
}

/**
 * What an OCSP response says about `cert`, or null when it is not about it.
 */
async function ocspFinding(
  basic: pkijs.BasicOCSPResponse,
  cert: pkijs.Certificate,
  issuer: pkijs.Certificate,
  validationTime: Date,
  label: string,
): Promise<StatusFinding | null> {
  let status: number;
  try {
    const answer = await basic.getCertificateStatus(cert, issuer);
    if (!answer.isForCertificate) return null;
    status = answer.status;
  } catch {
    return null;
  }
  const wanted = serialHex(cert.serialNumber);
  const single = basic.tbsResponseData.responses.find(
    (r) => serialHex(r.certID.serialNumber) === wanted,
  );

  const check = await verifyOcspResponse(basic, issuer);
  if (!check.verified) {
    return {
      status: RevocationStatus.UNKNOWN,
      revocationTime: null,
      detail: `${label} — OCSP response signature NOT verified (${check.reason}); status not trusted${status === 1 ? ' (the response says "revoked")' : ''}`,
      claimsRevoked: status === 1,
    };
  }
  if (status === 1) {
    return {
      status: RevocationStatus.REVOKED,
      revocationTime: single ? ocspRevocationTime(single) : null,
      detail: `${label} (OCSP signature verified)`,
    };
  }
  if (status === 0) {
    if (single?.nextUpdate && single.nextUpdate < validationTime) {
      return {
        status: RevocationStatus.UNKNOWN,
        revocationTime: null,
        detail: `${label} — OCSP response expired (nextUpdate ${single.nextUpdate.toISOString()} is before the validation time)`,
      };
    }
    return {
      status: RevocationStatus.GOOD,
      revocationTime: null,
      detail: `${label} (OCSP signature verified)`,
    };
  }
  return {
    status: RevocationStatus.UNKNOWN,
    revocationTime: null,
    detail: `${label} — responder answered "unknown"`,
  };
}

/**
 * What a CRL says about `cert`. The caller has already matched the issuer
 * name. A CRL whose signature cannot be checked (issuer certificate missing,
 * or verification failed) yields UNKNOWN.
 */
async function crlFinding(
  crl: pkijs.CertificateRevocationList,
  cert: pkijs.Certificate,
  issuer: pkijs.Certificate | null,
  validationTime: Date,
  label: string,
): Promise<StatusFinding> {
  const target = serialHex(cert.serialNumber);
  const listed = crl.revokedCertificates?.some((rc) => serialHex(rc.userCertificate) === target);
  const claim = listed ? ' (the CRL lists the certificate)' : '';
  if (!issuer) {
    return {
      status: RevocationStatus.UNKNOWN,
      revocationTime: null,
      detail: `${label} — CRL signature NOT verified (issuer certificate unavailable); status not trusted${claim}`,
      claimsRevoked: listed,
    };
  }
  let verified = false;
  try {
    verified = await crl.verify({ issuerCertificate: issuer });
  } catch {
    verified = false;
  }
  if (!verified) {
    return {
      status: RevocationStatus.UNKNOWN,
      revocationTime: null,
      detail: `${label} — CRL signature verification failed; status not trusted${claim}`,
      claimsRevoked: listed,
    };
  }
  const entry = crl.revokedCertificates?.find((rc) => serialHex(rc.userCertificate) === target);
  if (entry) {
    return {
      status: RevocationStatus.REVOKED,
      revocationTime: entry.revocationDate.value,
      detail: `${label} (CRL signature verified)`,
    };
  }
  // A revocation entry never expires, but "not listed" is only as good as the
  // CRL's validity window.
  if (crl.nextUpdate && crl.nextUpdate.value < validationTime) {
    return {
      status: RevocationStatus.UNKNOWN,
      revocationTime: null,
      detail: `${label} — CRL expired (nextUpdate ${crl.nextUpdate.value.toISOString()} is before the validation time)`,
    };
  }
  return {
    status: RevocationStatus.GOOD,
    revocationTime: null,
    detail: `${label} (CRL signature verified)`,
  };
}

/** Query an OCSP responder for the certificate's status */
async function fetchOcspStatus(
  cert: pkijs.Certificate,
  issuer: pkijs.Certificate,
  url: string,
  validationTime: Date,
): Promise<StatusFinding | null> {
  try {
    const request = new pkijs.OCSPRequest();
    await request.createForCertificate(cert, { hashAlgorithm: 'SHA-1', issuerCertificate: issuer });
    const body = request.toSchema(true).toBER(false);
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/ocsp-request' },
      body: Buffer.from(body),
    });
    if (!response.ok) {
      return {
        status: RevocationStatus.UNKNOWN,
        revocationTime: null,
        detail: `OCSP HTTP ${response.status}`,
      };
    }
    const der = new Uint8Array(await response.arrayBuffer());
    const [basic] = parseOcspResponses([der]);
    if (!basic) {
      return {
        status: RevocationStatus.UNKNOWN,
        revocationTime: null,
        detail: 'OCSP response unparseable',
      };
    }
    return (
      (await ocspFinding(basic, cert, issuer, validationTime, `OCSP responder ${url}`)) ?? {
        status: RevocationStatus.UNKNOWN,
        revocationTime: null,
        detail: 'OCSP response not for this certificate',
      }
    );
  } catch (error) {
    logger.debug(CONTEXT, `OCSP fetch failed: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/** Download and check a CRL against a certificate */
async function fetchCrlStatus(
  cert: pkijs.Certificate,
  url: string,
  issuer: pkijs.Certificate | null,
  validationTime: Date,
): Promise<StatusFinding | null> {
  try {
    const response = await fetchWithTimeout(url, { method: 'GET' });
    if (!response.ok) return null;
    const der = new Uint8Array(await response.arrayBuffer());
    const crl = parseCrls([der])[0];
    if (!crl) return null;
    // A fetched CRL from an untrusted (usually http) endpoint must match the
    // certificate's issuer, otherwise an on-path attacker could serve a forged
    // CRL that reports GOOD. Skip mismatched CRLs entirely.
    if (canonicalName(cert.issuer) !== canonicalName(crl.issuer)) return null;
    return await crlFinding(crl, cert, issuer, validationTime, `CRL from ${url}`);
  } catch (error) {
    logger.debug(CONTEXT, `CRL fetch failed: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

const ORIGIN_LABEL: Record<RevocationOrigin, string> = {
  dss: 'DSS',
  cms_signed_data: 'CMS SignedData.crls',
  cms_revocation_info_archival: 'CMS adbe-revocationInfoArchival',
};

export interface RevocationCheckInput {
  /** The certificate whose status is wanted (the signer, or a CA in the path) */
  signerCert: pkijs.Certificate;
  availableCerts: pkijs.Certificate[];
  embeddedOcsps: EmbeddedOcsp[];
  embeddedCrls: EmbeddedCrl[];
  /** Query OCSP / CRL endpoints when embedded data gives no verified answer */
  online: boolean;
  /** Validation time: expired "good" statements are not accepted (v0.27.0) */
  validationTime: Date;
}

interface Candidate {
  finding: StatusFinding;
  source: NonNullable<RevocationResult['source']>;
  origin: RevocationOrigin | null;
}

function toResult(c: Candidate): RevocationResult {
  return {
    status: c.finding.status,
    source: c.source,
    origin: c.origin,
    revocationTime: c.finding.revocationTime?.toISOString() ?? null,
    detail: c.finding.detail,
  };
}

/**
 * Check a certificate's revocation status.
 *
 * Order: embedded OCSP → embedded CRLs → (online) OCSP → (online) CRL.
 * A verified REVOKED ends the search. A verified GOOD ends the search.
 * Unverified or expired data is kept as the fallback answer (UNKNOWN, with
 * the source that held it) only when nothing better is found.
 *
 * REVOKED is reported as-is: whether it invalidates the signature depends on
 * the validation time's proof, which the caller owns.
 */
export async function checkRevocation(input: RevocationCheckInput): Promise<RevocationResult> {
  const { signerCert, validationTime } = input;
  const issuer = findIssuerCert(signerCert, input.availableCerts);
  let fallback: Candidate | null = null;
  // Unverified data that claims "revoked" is not trusted, but it must not
  // disappear either: a verified GOOD found later says so in its detail.
  const unverifiedRevocationClaims: string[] = [];
  const consider = (c: Candidate): RevocationResult | null => {
    if (c.finding.status !== RevocationStatus.UNKNOWN) {
      const result = toResult(c);
      if (result.status === RevocationStatus.GOOD && unverifiedRevocationClaims.length > 0) {
        result.detail = `${result.detail}; note: unverified data claims the certificate is revoked — ${unverifiedRevocationClaims.join('; ')}`;
      }
      return result;
    }
    if (c.finding.claimsRevoked) unverifiedRevocationClaims.push(c.finding.detail);
    fallback ??= c;
    return null;
  };

  // 1. Embedded OCSP responses (need the issuer to match the CertID)
  if (issuer) {
    for (const { response, origin } of input.embeddedOcsps) {
      const finding = await ocspFinding(
        response,
        signerCert,
        issuer,
        validationTime,
        `Embedded OCSP response (${ORIGIN_LABEL[origin]})`,
      );
      if (!finding) continue;
      const done = consider({ finding, source: 'ocsp_embedded', origin });
      if (done) return done;
    }
  }

  // 2. Embedded CRLs (issuer name must match)
  for (const { crl, origin } of input.embeddedCrls) {
    if (canonicalName(crl.issuer) !== canonicalName(signerCert.issuer)) continue;
    const finding = await crlFinding(
      crl,
      signerCert,
      issuer,
      validationTime,
      `Embedded CRL (${ORIGIN_LABEL[origin]})`,
    );
    const done = consider({ finding, source: 'crl_embedded', origin });
    if (done) return done;
  }

  // 3. Online (opt-in)
  if (input.online) {
    const ocspUrl = extractOcspUrl(signerCert);
    if (ocspUrl && issuer) {
      const finding = await fetchOcspStatus(signerCert, issuer, ocspUrl, validationTime);
      if (finding) {
        const done = consider({ finding, source: 'ocsp_online', origin: null });
        if (done) return done;
      }
    }
    for (const url of extractCrlUrls(signerCert)) {
      const finding = await fetchCrlStatus(signerCert, url, issuer, validationTime);
      if (finding) {
        const done = consider({ finding, source: 'crl_online', origin: null });
        if (done) return done;
      }
    }
  }

  if (fallback) return toResult(fallback);

  return {
    status: RevocationStatus.UNKNOWN,
    source: null,
    origin: null,
    revocationTime: null,
    detail: input.online
      ? 'No usable revocation source (embedded data absent; online endpoints unreachable or undeclared)'
      : 'No embedded revocation information found (use check_revocation="online" to query OCSP/CRL endpoints)',
  };
}
