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
  SHA1: '1.3.14.3.2.26',
  SHA256: '2.16.840.1.101.3.4.2.1',
  SHA384: '2.16.840.1.101.3.4.2.2',
  SHA512: '2.16.840.1.101.3.4.2.3',
} as const;

/** Map of digest algorithm OIDs to WebCrypto hash names */
export const DIGEST_OID_TO_HASH: Readonly<Record<string, string>> = {
  [OID.SHA1]: 'SHA-1',
  [OID.SHA256]: 'SHA-256',
  [OID.SHA384]: 'SHA-384',
  [OID.SHA512]: 'SHA-512',
};

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
