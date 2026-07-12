/**
 * pdf-verify-mcp shared constants
 */

/** Maximum response size in characters */
export const CHARACTER_LIMIT = 25_000;

/** Maximum PDF file size in bytes (100MB) */
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

/** Response format enum */
export enum ResponseFormat {
  MARKDOWN = 'markdown',
  JSON = 'json',
}

/** Signature verdicts */
export enum Verdict {
  VALID = 'valid',
  INVALID = 'invalid',
  INDETERMINATE = 'indeterminate',
}

/** PAdES baseline levels */
export enum PadesLevel {
  B_B = 'B-B',
  B_T = 'B-T',
  B_LT = 'B-LT',
  B_LTA = 'B-LTA',
}

/** Well-known OIDs used during CMS analysis */
export const OID = {
  SIGNED_DATA: '1.2.840.113549.1.7.2',
  DATA: '1.2.840.113549.1.7.1',
  CONTENT_TYPE: '1.2.840.113549.1.9.3',
  MESSAGE_DIGEST: '1.2.840.113549.1.9.4',
  SIGNING_TIME: '1.2.840.113549.1.9.5',
  SIGNATURE_TIME_STAMP: '1.2.840.113549.1.9.16.2.14',
  MD5: '1.2.840.113549.2.5',
  SHA1: '1.3.14.3.2.26',
  SHA256: '2.16.840.1.101.3.4.2.1',
  SHA384: '2.16.840.1.101.3.4.2.2',
  SHA512: '2.16.840.1.101.3.4.2.3',
} as const;

/** Map of digest algorithm OIDs to canonical hash names */
export const DIGEST_OID_TO_HASH: Readonly<Record<string, string>> = {
  [OID.MD5]: 'MD5',
  [OID.SHA1]: 'SHA-1',
  [OID.SHA256]: 'SHA-256',
  [OID.SHA384]: 'SHA-384',
  [OID.SHA512]: 'SHA-512',
};

/** Hash names supported by WebCrypto subtle.digest (others need node:crypto) */
export const WEBCRYPTO_HASHES: ReadonlySet<string> = new Set([
  'SHA-1',
  'SHA-256',
  'SHA-384',
  'SHA-512',
]);

/** Canonical hash name → node:crypto hash name */
export const NODE_HASH_NAMES: Readonly<Record<string, string>> = {
  MD5: 'md5',
  'SHA-1': 'sha1',
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
};

/** Digest algorithms considered cryptographically weak */
export const WEAK_DIGESTS: ReadonlySet<string> = new Set(['MD5', 'SHA-1']);

/** X.509 extension / access method OIDs used for revocation checking */
export const X509_OID = {
  AUTHORITY_INFO_ACCESS: '1.3.6.1.5.5.7.1.1',
  ACCESS_METHOD_OCSP: '1.3.6.1.5.5.7.48.1',
  ACCESS_METHOD_CA_ISSUERS: '1.3.6.1.5.5.7.48.2',
  CRL_DISTRIBUTION_POINTS: '2.5.29.31',
} as const;

/** Maximum chain depth when fetching issuer certificates via AIA */
export const AIA_MAX_CHAIN_DEPTH = 5;

/** Environment variable: directory containing default trust anchor certificates */
export const TRUST_ANCHORS_ENV = 'PDF_VERIFY_TRUST_ANCHORS';

/** Environment variable: path to the veraPDF executable */
export const VERAPDF_ENV = 'PDF_VERIFY_VERAPDF';

/** Timeout for veraPDF CLI execution (ms) */
export const VERAPDF_TIMEOUT = 120_000;

/** Conformance validation engine selection */
export enum ValidationEngine {
  AUTO = 'auto',
  NATIVE = 'native',
  VERAPDF = 'verapdf',
}

/** Timeout for online OCSP/CRL fetches (ms) */
export const REVOCATION_FETCH_TIMEOUT = 10_000;

/**
 * ASN.1 parse limits for large revocation structures.
 * asn1js defaults (maxNodes=10,000) are too small for real-world CRLs —
 * e.g. DigiCert CRLs contain tens of thousands of revoked entries.
 */
export const ASN1_LARGE_STRUCTURE_LIMITS = {
  maxNodes: 5_000_000,
  maxDepth: 100,
  maxContentLength: 64 * 1024 * 1024,
} as const;

/** Revocation check modes */
export enum RevocationMode {
  NONE = 'none',
  EMBEDDED = 'embedded',
  ONLINE = 'online',
}

/** Trust evaluation outcome */
export enum TrustStatus {
  TRUSTED = 'trusted',
  UNTRUSTED = 'untrusted',
  NOT_EVALUATED = 'not_evaluated',
}

/** Certificate revocation outcome */
export enum RevocationStatus {
  GOOD = 'good',
  REVOKED = 'revoked',
  UNKNOWN = 'unknown',
  NOT_CHECKED = 'not_checked',
}

/** SubFilter values (PDF signature encodings) */
export const SUB_FILTER = {
  ADBE_PKCS7_DETACHED: 'adbe.pkcs7.detached',
  ADBE_PKCS7_SHA1: 'adbe.pkcs7.sha1',
  ETSI_CADES_DETACHED: 'ETSI.CAdES.detached',
  ETSI_RFC3161: 'ETSI.RFC3161',
} as const;

/** DocMDP permission levels (ISO 32000-1 Table 254) */
export const DOCMDP_PERMISSIONS: Readonly<Record<number, string>> = {
  1: 'No changes permitted',
  2: 'Filling in forms, instantiating page templates, and signing permitted',
  3: 'Form fill-in, signing, annotation creation/deletion/modification permitted',
};
