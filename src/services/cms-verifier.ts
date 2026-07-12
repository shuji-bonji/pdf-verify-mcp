/**
 * CMS/PKCS#7 cryptographic verification service (pkijs + WebCrypto).
 *
 * Responsibilities:
 * - Parse the DER-encoded CMS payload from a signature's /Contents
 * - Verify the ByteRange digest against the messageDigest signed attribute
 * - Cryptographically verify the signature value with the signer certificate
 * - Summarize embedded certificates
 *
 * NOT in scope (v0.1): trust chain evaluation against trust anchors,
 * OCSP/CRL revocation checking. Results always carry trust: 'not_evaluated'.
 */

import { webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { DIGEST_OID_TO_HASH, OID } from '../constants.js';
import type { CertificateInfo, CmsVerificationResult } from '../types.js';
import { logger } from '../utils/logger.js';

const CONTEXT = 'cms-verifier';

let engineInitialized = false;

/** Initialize the pkijs crypto engine with Node's WebCrypto (idempotent) */
export function ensureCryptoEngine(): void {
  if (engineInitialized) return;
  pkijs.setEngine(
    'node-webcrypto',
    new pkijs.CryptoEngine({
      name: 'node-webcrypto',
      crypto: webcrypto as unknown as pkijs.CryptoEngineParameters['crypto'],
    }),
  );
  engineInitialized = true;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Map common attribute type OIDs in an RDN to short names */
const RDN_OID_NAMES: Readonly<Record<string, string>> = {
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '1.2.840.113549.1.9.1': 'E',
};

function formatRdn(rdn: pkijs.RelativeDistinguishedNames): string {
  return rdn.typesAndValues
    .map((tv) => {
      const name = RDN_OID_NAMES[tv.type] ?? tv.type;
      return `${name}=${tv.value.valueBlock.value}`;
    })
    .join(', ');
}

function summarizeCertificate(cert: pkijs.Certificate): CertificateInfo {
  const subject = formatRdn(cert.subject);
  const issuer = formatRdn(cert.issuer);
  const notAfter = cert.notAfter.value;
  return {
    subject,
    issuer,
    serialNumber: bytesToHex(new Uint8Array(cert.serialNumber.valueBlock.valueHexView)),
    notBefore: cert.notBefore.value.toISOString(),
    notAfter: notAfter.toISOString(),
    isSelfSigned: subject === issuer,
    isExpiredNow: notAfter.getTime() < Date.now(),
  };
}

interface ParsedCms {
  signedData: pkijs.SignedData;
  signerInfo: pkijs.SignerInfo;
}

function parseCms(contents: Uint8Array): ParsedCms {
  const asn1 = asn1js.fromBER(toArrayBuffer(contents));
  if (asn1.offset === -1) {
    throw new Error('CMS payload is not valid BER/DER');
  }
  const contentInfo = new pkijs.ContentInfo({ schema: asn1.result });
  if (contentInfo.contentType !== OID.SIGNED_DATA) {
    throw new Error(`Unexpected CMS content type: ${contentInfo.contentType}`);
  }
  const signedData = new pkijs.SignedData({ schema: contentInfo.content });
  if (signedData.signerInfos.length === 0) {
    throw new Error('CMS SignedData contains no SignerInfo');
  }
  return { signedData, signerInfo: signedData.signerInfos[0] };
}

function findAttribute(
  attrs: pkijs.SignedAndUnsignedAttributes | undefined,
  oid: string,
): pkijs.Attribute | null {
  if (!attrs) return null;
  return attrs.attributes.find((a) => a.type === oid) ?? null;
}

function extractSigningTime(signerInfo: pkijs.SignerInfo): string | null {
  const attr = findAttribute(signerInfo.signedAttrs, OID.SIGNING_TIME);
  if (!attr || attr.values.length === 0) return null;
  const value = attr.values[0] as asn1js.UTCTime | asn1js.GeneralizedTime;
  try {
    return value.toDate().toISOString();
  } catch {
    return null;
  }
}

function extractMessageDigest(signerInfo: pkijs.SignerInfo): Uint8Array | null {
  const attr = findAttribute(signerInfo.signedAttrs, OID.MESSAGE_DIGEST);
  if (!attr || attr.values.length === 0) return null;
  const octet = attr.values[0] as asn1js.OctetString;
  return new Uint8Array(octet.valueBlock.valueHexView);
}

function findSignerCertificate(parsed: ParsedCms): pkijs.Certificate | null {
  const certs = (parsed.signedData.certificates ?? []).filter(
    (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
  );
  const sid = parsed.signerInfo.sid;
  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    const serial = bytesToHex(new Uint8Array(sid.serialNumber.valueBlock.valueHexView));
    const match = certs.find(
      (c) => bytesToHex(new Uint8Array(c.serialNumber.valueBlock.valueHexView)) === serial,
    );
    if (match) return match;
  }
  return certs[0] ?? null;
}

/**
 * Verify one CMS signature against the bytes covered by its ByteRange.
 *
 * @param contents  DER CMS payload (zero padding already stripped)
 * @param signedBytes  Concatenated ByteRange bytes the signature covers
 */
export async function verifyCms(
  contents: Uint8Array,
  signedBytes: Uint8Array,
): Promise<CmsVerificationResult> {
  ensureCryptoEngine();

  const result: CmsVerificationResult = {
    signatureVerified: false,
    digestMatches: null,
    digestAlgorithm: null,
    signingTimeAttribute: null,
    hasSignatureTimestamp: false,
    signerCertificate: null,
    embeddedCertificateCount: 0,
    error: null,
  };

  let parsed: ParsedCms;
  try {
    parsed = parseCms(contents);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }

  const { signedData, signerInfo } = parsed;

  result.embeddedCertificateCount = (signedData.certificates ?? []).length;
  result.signingTimeAttribute = extractSigningTime(signerInfo);
  result.hasSignatureTimestamp =
    findAttribute(signerInfo.unsignedAttrs, OID.SIGNATURE_TIME_STAMP) !== null;

  const digestOid = signerInfo.digestAlgorithm.algorithmId;
  const hashName = DIGEST_OID_TO_HASH[digestOid] ?? null;
  result.digestAlgorithm = hashName;

  const signerCert = findSignerCertificate(parsed);
  if (signerCert) {
    result.signerCertificate = summarizeCertificate(signerCert);
  }

  // 1. Independent digest comparison (ByteRange digest vs messageDigest attribute)
  if (hashName) {
    const expected = extractMessageDigest(signerInfo);
    if (expected) {
      const actual = new Uint8Array(
        await webcrypto.subtle.digest(hashName, toArrayBuffer(signedBytes)),
      );
      result.digestMatches = bytesToHex(actual) === bytesToHex(expected);
    }
  } else {
    result.error = `Unsupported digest algorithm OID: ${digestOid}`;
  }

  // 2. Cryptographic signature verification via pkijs
  try {
    const hasEncapsulatedContent = Boolean(signedData.encapContentInfo.eContent);
    result.signatureVerified = await signedData.verify({
      signer: 0,
      checkChain: false,
      // Detached signatures need the external data; encapsulated ones do not.
      ...(hasEncapsulatedContent ? {} : { data: toArrayBuffer(signedBytes) }),
    });
  } catch (error) {
    result.signatureVerified = false;
    const message = error instanceof Error ? error.message : String(error);
    result.error = result.error ? `${result.error}; ${message}` : message;
    logger.debug(CONTEXT, `signature verification failed: ${message}`);
  }

  return result;
}

/**
 * For an RFC 3161 document timestamp: compare the TSTInfo messageImprint
 * against the digest of the signed bytes. Returns null when parsing fails.
 */
export async function verifyTimestampImprint(
  contents: Uint8Array,
  signedBytes: Uint8Array,
): Promise<boolean | null> {
  ensureCryptoEngine();
  try {
    const parsed = parseCms(contents);
    const eContent = parsed.signedData.encapContentInfo.eContent;
    if (!eContent) return null;
    const tstAsn1 = asn1js.fromBER(eContent.valueBlock.valueHexView.slice().buffer);
    if (tstAsn1.offset === -1) return null;
    const tstInfo = new pkijs.TSTInfo({ schema: tstAsn1.result });
    const hashName = DIGEST_OID_TO_HASH[tstInfo.messageImprint.hashAlgorithm.algorithmId];
    if (!hashName) return null;
    const actual = new Uint8Array(
      await webcrypto.subtle.digest(hashName, toArrayBuffer(signedBytes)),
    );
    const expected = new Uint8Array(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView);
    return bytesToHex(actual) === bytesToHex(expected);
  } catch {
    return null;
  }
}
