/**
 * Shared types for pdf-verify-mcp
 */

import type { PadesLevel, Verdict } from './constants.js';

/** A signature (or document timestamp) found in the PDF */
export interface SignatureField {
  /** Field name (/T) if the signature is attached to an AcroForm field */
  fieldName: string | null;
  /** /Filter value (signature handler) */
  filter: string | null;
  /** /SubFilter value (signature encoding) */
  subFilter: string | null;
  /** /ByteRange [offset1, length1, offset2, length2] */
  byteRange: number[] | null;
  /** Raw CMS bytes from /Contents (trailing zero padding stripped) */
  contents: Uint8Array | null;
  /** /M signing time string (PDF date) */
  signingTimeDictionary: string | null;
  /** /Name, /Reason, /Location from the signature dictionary */
  name: string | null;
  reason: string | null;
  location: string | null;
  /** true when /Type is /DocTimeStamp */
  isDocumentTimestamp: boolean;
  /** DocMDP permission (1-3) when this is a certification signature */
  docMdpPermission: number | null;
}

/** Certificate summary extracted from the CMS payload */
export interface CertificateInfo {
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  isSelfSigned: boolean;
  isExpiredNow: boolean;
}

/** Result of cryptographic verification of one CMS signature */
export interface CmsVerificationResult {
  /** true when the signature value verified against the signer certificate */
  signatureVerified: boolean;
  /** true when the computed ByteRange digest matches the CMS messageDigest attribute */
  digestMatches: boolean | null;
  /** Digest algorithm used (WebCrypto name, e.g. 'SHA-256') */
  digestAlgorithm: string | null;
  /** signingTime signed attribute (ISO string) when present */
  signingTimeAttribute: string | null;
  /** true when a RFC 3161 signature timestamp is embedded in unsigned attributes */
  hasSignatureTimestamp: boolean;
  /** Signer certificate summary */
  signerCertificate: CertificateInfo | null;
  /** All certificates embedded in the CMS */
  embeddedCertificateCount: number;
  /** Failure/diagnostic detail when verification could not complete */
  error: string | null;
}

/** Per-signature verification report */
export interface SignatureVerificationReport {
  fieldName: string | null;
  subFilter: string | null;
  verdict: Verdict;
  /** Trust chain evaluation is out of scope in v0.1 — always 'not_evaluated' */
  trust: 'not_evaluated';
  /** Whether the ByteRange covers the entire file (except /Contents) */
  coversEntireFile: boolean | null;
  /** Byte count that follows the signed range (revisions after signing) */
  bytesAfterSignedRange: number | null;
  cms: CmsVerificationResult | null;
  signingTimeDictionary: string | null;
  reason: string | null;
  location: string | null;
  isDocumentTimestamp: boolean;
  notes: string[];
}

/** Document integrity report */
export interface IntegrityReport {
  fileSize: number;
  /** Number of revisions detected (startxref count) */
  revisionCount: number;
  incrementalUpdateCount: number;
  signatureCount: number;
  /** Signatures whose signed range is followed by additional bytes */
  signaturesWithLaterChanges: {
    fieldName: string | null;
    bytesAfterSignedRange: number;
  }[];
  /** DocMDP certification info when present */
  certification: {
    fieldName: string | null;
    permission: number;
    permissionDescription: string;
    violatedByLaterChanges: boolean;
  } | null;
  /** Whether the last signature covers the entire file */
  lastSignatureCoversFile: boolean | null;
  hasDss: boolean;
  notes: string[];
}

/** PAdES level detection result for one signature */
export interface PadesLevelReport {
  fieldName: string | null;
  subFilter: string | null;
  isPades: boolean;
  level: PadesLevel | null;
  evidence: {
    hasSignatureTimestamp: boolean;
    hasDss: boolean;
    hasVri: boolean;
    hasDocumentTimestamp: boolean;
  };
  notes: string[];
}

/** PDF/A / PDF/UA declaration found in XMP */
export interface ConformanceReport {
  hasXmp: boolean;
  pdfA: { part: string; conformance: string | null } | null;
  pdfUa: { part: string } | null;
  pdfVersion: string | null;
  notes: string[];
}

/** Low-level parse result of the whole document */
export interface ParsedPdf {
  bytes: Uint8Array;
  fileSize: number;
  /** true when the document uses PDF encryption (strings are not decodable) */
  isEncrypted: boolean;
  signatures: SignatureField[];
  revisionCount: number;
  hasDss: boolean;
  hasVri: boolean;
  xmpMetadata: string | null;
  pdfVersion: string | null;
}
