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

import { createHash, createPublicKey, verify as nodeCryptoVerify, webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { DIGEST_OID_TO_HASH, NODE_HASH_NAMES, OID, WEBCRYPTO_HASHES } from '../constants.js';
import type { CertificateInfo, CmsVerificationResult, TimestampTokenResult } from '../types.js';
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

/** Compute a digest, using node:crypto for algorithms WebCrypto lacks (MD5) */
async function computeDigest(hashName: string, data: Uint8Array): Promise<Uint8Array> {
  if (WEBCRYPTO_HASHES.has(hashName)) {
    return new Uint8Array(await webcrypto.subtle.digest(hashName, toArrayBuffer(data)));
  }
  const nodeName = NODE_HASH_NAMES[hashName];
  if (!nodeName) throw new Error(`Unsupported digest algorithm: ${hashName}`);
  return new Uint8Array(createHash(nodeName).update(data).digest());
}

/**
 * Legacy RSA PKCS#1 v1.5 verification via node:crypto for algorithms
 * WebCrypto does not support (notably MD5, used e.g. by AWS invoices).
 *
 * When signedAttrs are present the signature covers their DER encoding
 * with the IMPLICIT [0] tag replaced by SET (0x31) — same re-tagging
 * pkijs performs internally.
 */
function verifySignatureLegacy(
  signerInfo: pkijs.SignerInfo,
  signerCert: pkijs.Certificate,
  signedBytes: Uint8Array,
  hashName: string,
): boolean {
  const nodeName = NODE_HASH_NAMES[hashName];
  if (!nodeName) return false;

  let data: Buffer;
  if (signerInfo.signedAttrs) {
    data = Buffer.from(new Uint8Array(signerInfo.signedAttrs.encodedValue));
    data[0] = 0x31;
  } else {
    data = Buffer.from(signedBytes);
  }

  const spkiDer = Buffer.from(signerCert.subjectPublicKeyInfo.toSchema().toBER(false));
  const publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  const signature = Buffer.from(new Uint8Array(signerInfo.signature.valueBlock.valueHexView));
  return nodeCryptoVerify(nodeName, data, publicKey, signature);
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
    signatureTimestamp: null,
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
  const tsAttr = findAttribute(signerInfo.unsignedAttrs, OID.SIGNATURE_TIME_STAMP);
  result.hasSignatureTimestamp = tsAttr !== null;
  if (tsAttr && tsAttr.values.length > 0) {
    try {
      const tokenDer = new Uint8Array((tsAttr.values[0] as asn1js.Sequence).toBER(false));
      // The signature timestamp's messageImprint covers the signature value.
      result.signatureTimestamp = await verifyTimestampToken(
        tokenDer,
        new Uint8Array(signerInfo.signature.valueBlock.valueHexView),
      );
    } catch (error) {
      result.signatureTimestamp = {
        imprintMatches: null,
        signatureVerified: false,
        genTime: null,
        tsaSubject: null,
        tsaTrust: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

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
      try {
        const actual = await computeDigest(hashName, signedBytes);
        result.digestMatches = bytesToHex(actual) === bytesToHex(expected);
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
    }
  } else {
    result.error = `Unsupported digest algorithm OID: ${digestOid}`;
  }

  // 2. Cryptographic signature verification.
  // WebCrypto-supported algorithms go through pkijs; legacy algorithms
  // (e.g. MD5-based signatures on old AWS invoices) fall back to node:crypto.
  const useLegacyPath = hashName !== null && !WEBCRYPTO_HASHES.has(hashName);
  try {
    if (useLegacyPath) {
      if (!signerCert) throw new Error('Signer certificate not found in CMS');
      result.signatureVerified = verifySignatureLegacy(
        signerInfo,
        signerCert,
        signedBytes,
        hashName,
      );
      result.error = null; // supersede the provisional "unsupported" diagnostic
      if (!result.signatureVerified) {
        result.error = `Legacy ${hashName} signature verification failed`;
      }
    } else {
      const hasEncapsulatedContent = Boolean(signedData.encapContentInfo.eContent);
      result.signatureVerified = await signedData.verify({
        signer: 0,
        checkChain: false,
        // Detached signatures need the external data; encapsulated ones do not.
        ...(hasEncapsulatedContent ? {} : { data: toArrayBuffer(signedBytes) }),
      });
    }
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
  const result = await verifyTimestampToken(contents, signedBytes);
  return result.imprintMatches;
}

/**
 * Extract the raw bytes of an OCTET STRING, handling BER constructed
 * (segmented) encodings where the payload is split across inner
 * OCTET STRING chunks (pkijs produces these for encapsulated content).
 */
function octetStringBytes(octet: asn1js.OctetString): Uint8Array {
  if (!octet.idBlock.isConstructed) {
    return new Uint8Array(octet.valueBlock.valueHexView);
  }
  const chunks = (octet.valueBlock.value as asn1js.OctetString[]).map((part) =>
    octetStringBytes(part),
  );
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Fully verify an RFC 3161 timestamp token (v0.2):
 * - TSTInfo messageImprint vs digest of the covered data
 * - TSA CMS signature over the encapsulated TSTInfo
 */
export async function verifyTimestampToken(
  tokenDer: Uint8Array,
  imprintData: Uint8Array,
): Promise<TimestampTokenResult> {
  ensureCryptoEngine();
  const result: TimestampTokenResult = {
    imprintMatches: null,
    signatureVerified: false,
    genTime: null,
    tsaSubject: null,
    tsaTrust: null,
    error: null,
  };

  let parsed: ParsedCms;
  try {
    parsed = parseCms(tokenDer);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }

  try {
    const eContent = parsed.signedData.encapContentInfo.eContent;
    if (!eContent) {
      result.error = 'Timestamp token has no encapsulated TSTInfo';
      return result;
    }
    const tstDer = octetStringBytes(eContent);
    const tstAsn1 = asn1js.fromBER(toArrayBuffer(tstDer));
    if (tstAsn1.offset !== -1) {
      const tstInfo = new pkijs.TSTInfo({ schema: tstAsn1.result });
      result.genTime = tstInfo.genTime.toISOString();
      const hashName = DIGEST_OID_TO_HASH[tstInfo.messageImprint.hashAlgorithm.algorithmId];
      if (hashName) {
        const actual = await computeDigest(hashName, imprintData);
        const expected = new Uint8Array(
          tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView,
        );
        result.imprintMatches = bytesToHex(actual) === bytesToHex(expected);
      }
    }

    const tsaCert = findSignerCertificate(parsed);
    if (tsaCert) {
      result.tsaSubject = formatRdn(tsaCert.subject);
    }

    // TSA CMS signature verification. pkijs treats TSTInfo content specially:
    // it re-checks the messageImprint against `data`, so pass the covered data.
    result.signatureVerified = await parsed.signedData.verify({
      signer: 0,
      checkChain: false,
      data: toArrayBuffer(imprintData),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.error = result.error ? `${result.error}; ${message}` : message;
  }
  return result;
}

/** Artifacts extracted from a CMS payload for trust/revocation analysis */
export interface CmsArtifacts {
  signerCert: pkijs.Certificate | null;
  certificates: pkijs.Certificate[];
  /** CRLs embedded in the CMS RevocationInfoChoices */
  crls: pkijs.CertificateRevocationList[];
  /** Signing time from the signed attribute, when present */
  signingTime: Date | null;
  /** Raw DER of the signature timestamp token in unsignedAttrs, when present */
  signatureTimestampToken: Uint8Array | null;
  /** The signature value bytes (imprint data for the signature timestamp) */
  signatureValue: Uint8Array;
}

/** Extract certificates, CRLs and timestamp material from a CMS payload */
export function extractCmsArtifacts(contents: Uint8Array): CmsArtifacts | null {
  ensureCryptoEngine();
  let parsed: ParsedCms;
  try {
    parsed = parseCms(contents);
  } catch {
    return null;
  }
  const { signedData, signerInfo } = parsed;

  const certificates = (signedData.certificates ?? []).filter(
    (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
  );
  const crls = (signedData.crls ?? []).filter(
    (c): c is pkijs.CertificateRevocationList => c instanceof pkijs.CertificateRevocationList,
  );

  const tsAttr = findAttribute(signerInfo.unsignedAttrs, OID.SIGNATURE_TIME_STAMP);
  let tokenDer: Uint8Array | null = null;
  if (tsAttr && tsAttr.values.length > 0) {
    try {
      tokenDer = new Uint8Array((tsAttr.values[0] as asn1js.Sequence).toBER(false));
    } catch {
      tokenDer = null;
    }
  }

  const signingTimeIso = extractSigningTime(signerInfo);

  return {
    signerCert: findSignerCertificate(parsed),
    certificates,
    crls,
    signingTime: signingTimeIso ? new Date(signingTimeIso) : null,
    signatureTimestampToken: tokenDer,
    signatureValue: new Uint8Array(signerInfo.signature.valueBlock.valueHexView),
  };
}
