/**
 * Shared types for pdf-verify-mcp
 */

import type { PadesLevel, RevocationStatus, TrustStatus, Verdict } from './constants.js';

/** Result of trust chain evaluation against trust anchors */
export interface TrustResult {
  status: TrustStatus;
  /** Human-readable detail (engine message, anchor source, or why not evaluated) */
  detail: string | null;
  /** Subjects along the validated certificate path (leaf first) */
  certificatePath: string[] | null;
}

/** Result of revocation checking for the signer certificate */
export interface RevocationResult {
  status: RevocationStatus;
  /** Where the decisive revocation information came from */
  source: 'ocsp_embedded' | 'crl_embedded' | 'ocsp_online' | 'crl_online' | null;
  detail: string | null;
}

/** Result of RFC 3161 timestamp token verification */
export interface TimestampTokenResult {
  /** messageImprint matches the data the timestamp covers */
  imprintMatches: boolean | null;
  /** TSA CMS signature verified */
  signatureVerified: boolean;
  /** genTime from TSTInfo (ISO string) */
  genTime: string | null;
  /** TSA certificate subject when present */
  tsaSubject: string | null;
  /** TSA certificate chain evaluation against trust anchors (v0.4+) */
  tsaTrust: TrustResult | null;
  error: string | null;
}

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
  /** Verification result of the signature timestamp token (v0.2+, null when absent) */
  signatureTimestamp: TimestampTokenResult | null;
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
  /** Trust chain evaluation result (v0.2+) */
  trust: TrustResult;
  /** Revocation check result for the signer certificate (v0.2+) */
  revocation: RevocationResult | null;
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
    /**
     * true when bytes were added after the certified range but a DSS and/or
     * document timestamp is present — the ISO 32000-2 §12.8.2.2 exception
     * that permits such incremental updates even when P=1 (structural
     * detection only; the updates' object-level content is not verified)
     */
    laterChangesAppearLtvOnly: boolean;
  } | null;
  /** Whether the last signature covers the entire file */
  lastSignatureCoversFile: boolean | null;
  hasDss: boolean;
  notes: string[];
}

/**
 * どの規範を手元に持っているかで、結果をどの強さで述べられるかが変わる（PDFfamily `specs/09 §2`）。
 *
 * - `T1` — ISO 32000-1/-2・ISO 14289: 条文を引用して断定できる
 * - `T2` — ISO 19005（PDF/A）: コーパス外。**判定は veraPDF が下す**ので
 *   「veraPDF はこう判定した」までしか言えない
 * - `T3` — ETSI EN 319 142（PAdES）: 規範も第三者検証器も無い。**構造の観測を報告するだけ**で
 *   適合判定ではない
 *
 * **`clause` とは独立の軸**である。`clause` は「どの規範か」、こちらは「その規範を条文で引けるか」。
 */
export type NormativeBasis = 'T1' | 'T2' | 'T3';

/**
 * PAdES level detection result for one signature.
 *
 * **これは観測であって適合判定ではない**（`normativeBasis: 'T3'`）。
 * ETSI EN 319 142 の原文は family のコーパスに無く、PDF/A のような第三者検証器（veraPDF）も無い。
 * したがって `level` が意味するのは「**構造がこのレベルの形に一致する**」であり、
 * 「このレベルに適合している」ではない（`specs/09 §2`「T3 における観測と判定の分界」）。
 */
export interface PadesLevelReport {
  fieldName: string | null;
  subFilter: string | null;
  isPades: boolean;
  /**
   * 構造が一致した PAdES ベースラインレベル。**適合の主張ではない** — 上のコメントと
   * `normativeBasis` を参照。判定できなかった場合は null。
   */
  level: PadesLevel | null;
  /**
   * この結果を述べられる強さ。PAdES は常に **`'T3'`**（規範根拠なし・構造の観測）。
   * レポートを書くときは、この値を見て文言を選ぶ。
   */
  normativeBasis: NormativeBasis;
  evidence: {
    hasSignatureTimestamp: boolean;
    hasDss: boolean;
    hasVri: boolean;
    hasDocumentTimestamp: boolean;
  };
  /** Content-level LTV validation (v0.2+): does DSS revocation data cover the signer? */
  ltv: {
    dssCertCount: number;
    dssOcspCount: number;
    dssCrlCount: number;
    revocationDataCoversSigner: boolean | null;
  } | null;
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
  /** true when the document uses PDF encryption */
  isEncrypted: boolean;
  /** true when encryption was successfully reversed (v0.5) */
  decrypted: boolean;
  signatures: SignatureField[];
  revisionCount: number;
  hasDss: boolean;
  hasVri: boolean;
  /** Decoded DSS streams (DER bytes) when a DSS is present */
  dss: {
    certs: Uint8Array[];
    ocsps: Uint8Array[];
    crls: Uint8Array[];
  } | null;
  xmpMetadata: string | null;
  pdfVersion: string | null;
}
