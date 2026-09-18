/**
 * pdf-verify-mcp shared constants
 */

/**
 * Maximum size of a **markdown** response, in characters (v0.29.0, #18).
 *
 * JSON responses are never cut by length: a JSON body cut mid-structure is
 * unreadable, and `isError` stays false, so the caller finds out only when
 * `JSON.parse` fails. What bounds a JSON response is the per-array caps below
 * (`MAX_SIGNATURES`, `MAX_REVISIONS`, `MAX_FINDINGS`), which keep the body
 * valid and say what was left out. Markdown is read by people, so losing the
 * tail is tolerable; this limit is the safety net for it.
 */
export const CHARACTER_LIMIT = 50_000;

/**
 * Per-array caps for JSON responses (v0.29.0, #18). Measured on 209 signed
 * specimens: 1 signature in 100, 2 in 45, at most 6 in real documents; the one
 * 51-signature file is a validator test case. One signature report is about
 * 2,000 characters, so 32 keeps `verify_signatures` under 100 KB.
 */
export const MAX_SIGNATURES = 32;
/** Revisions listed by verify_integrity (changes per revision are capped separately) */
export const MAX_REVISIONS = 32;
/** Violations / clause results listed by validate_conformance and validate_clauses */
export const MAX_FINDINGS = 200;

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
  /** Adobe's signed attribute carrying CRLs / OCSP responses (ISO 32000-2 §12.8.3.3.1) */
  ADBE_REVOCATION_INFO_ARCHIVAL: '1.2.840.113583.1.1.8',
  /** id-ct-TSTInfo — eContentType of an RFC 3161 timestamp token (RFC 3161 §2.4.2) */
  TST_INFO: '1.2.840.113549.1.9.16.1.4',
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
  EXTENDED_KEY_USAGE: '2.5.29.37',
  KP_OCSP_SIGNING: '1.3.6.1.5.5.7.3.9',
  /** id-pkix-ocsp-nocheck (RFC 6960 §4.2.2.2.1) */
  OCSP_NOCHECK: '1.3.6.1.5.5.7.48.1.5',
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

/**
 * Default revocation freshness (seconds): how long before the validation time
 * a CRL / OCSP response may have been issued and still support "good"
 * (v0.28.0, #16). Measured on 82 real "good" signatures: 51 have data issued
 * at or after the validation time, 68 within 1 hour, 79 within 24 hours.
 */
export const DEFAULT_REVOCATION_FRESHNESS_SECONDS = 24 * 3600;

/** Depth limit when checking the revocation of revocation-data signers */
export const REVOCATION_SIGNER_CHECK_DEPTH = 2;

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
  /**
   * Revoked, but a verified timestamp proves the signature existed before the
   * revocation time (ISO 32000-2 §12.8.3.4.6 case 2). Does not invalidate.
   */
  REVOKED_AFTER_VALIDATION_TIME = 'revoked_after_validation_time',
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
