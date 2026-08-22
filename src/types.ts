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
  /**
   * Raw CMS bytes from /Contents, cut at the length the DER header declares.
   * (Not "trailing zeros removed" — a DER blob may legitimately end with 0x00.)
   */
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
    /**
     * `violationAssessment === 'violated'`. Kept as a boolean for callers that
     * only branch on "is this a problem"; **`indeterminate` reads as `false`
     * here**, so anything that must not treat "could not tell" as "fine"
     * should read `violationAssessment` instead.
     */
    violatedByLaterChanges: boolean;
    /**
     * What the later changes were, against the permissions P grants
     * (ISO 32000-2 Table 257):
     *
     * - `permitted` — every later change falls inside what P allows
     * - `violated` — at least one change is outside it
     * - `indeterminate` — the change chain could not be read, or a changed
     *   object's kind could not be determined. **NOT a pass.** Same discipline
     *   as `validate_clauses` returning `needs_external_fact` rather than
     *   defaulting a check into a pass: this server disproves, and "could not
     *   be disproved" is a different statement from "is fine".
     */
    violationAssessment: DocMdpAssessment;
    /** Why the assessment came out that way, in one line */
    assessmentReason: string;
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
  /**
   * Object-level view of the incremental-update chain (v0.10+, Issue #8).
   *
   * `null` when the cross-reference chain could not be walked — which is not
   * the same as "nothing changed" and must never be reported as such.
   *
   * **This does not move the verdict.** Incremental updates are legal in PDF
   * (ISO 32000-2 §7.5.6); the list says what to look at, not what is wrong.
   */
  revisions: RevisionSummary[] | null;
  /**
   * Whether `revisions` above is the whole history (v0.16+, V-F6).
   *
   * 🔴 **A returned list is not evidence of completeness.** When the chain is
   * cut, `revisions` still comes back non-null and non-empty, and the single
   * revision that survives is reported as the original one — `changeCount: 0`,
   * `changes: null`. Every other machine-readable field then says "nothing was
   * appended" about a file that demonstrably had an append. Until 0.15.2 the
   * only signal was English prose in `notes`, so a caller had to match strings
   * to decide whether it could promise a full history.
   *
   * `status` is the one thing to branch on, and it is derived in a single
   * place so the three cases cannot drift apart:
   *
   * - `complete` — walked from the newest cross-reference section back to the
   *   original revision. Only here does "no such change appears in the list"
   *   mean "that change was not made".
   * - `partial` — walked, but `missing` names the ends that are absent.
   * - `unwalkable` — no section could be read at all; `revisions` is `null`.
   *   **NOT a pass**, the same discipline as `violationAssessment`'s
   *   `indeterminate`: "could not be read" and "nothing there" are different
   *   statements.
   *
   * The *cause* stays in `notes` (a damaged or cyclic `/Prev`, the revision
   * cap, an unparseable newest section). The field carries the consequence,
   * because that is what a caller branches on.
   */
  revisionChain: RevisionChainCoverage;
  /**
   * Why `revisionCount` and `revisions.length` differ, when they do
   * (v0.17+, V-F7).
   *
   * The two count different things and **differ lawfully**: `revisionCount`
   * counts `startxref` keywords in the byte stream, `revisions` lists the
   * cross-reference sections the chain actually reached. A linearised file
   * (ISO 32000-2 Annex F) writes two sections for one save; a chain that could
   * not be followed in full reaches fewer sections than there are keywords.
   *
   * Until 0.17.0 the report carried neither the linearisation flag nor this
   * reconciliation: `notes` said the counts differ "in linearised files and in
   * files carrying a cross-reference section no chain points at" — two causes
   * side by side, with nothing saying which one this file is.
   *
   * `status` is the arithmetic; `causes` are the facts read from the file:
   *
   * - `agree` — the two counts are equal.
   * - `accounted` — they differ and every `causes` entry says why.
   * - `unaccounted` — they differ and nothing read from the file explains it.
   *   **This is the case to look at**: the file holds a `startxref` the walked
   *   chain does not reach.
   *
   * `causes` is about the file, not about the subtraction, so it can be
   * non-empty while `status` is `agree`.
   */
  revisionCountAgreement: RevisionCountAgreement;
  /**
   * Objects written by revisions that were appended after the last signed
   * range ended — the shortlist UC-10 hands to a reader for locating.
   * Empty when there is no signature or nothing followed it.
   */
  objectChangesAfterLastSignature: RevisionObjectChange[];
  notes: string[];
}

/**
 * How much of the revision history `revisions` actually covers.
 *
 * `missing` names **which end** of the history is absent rather than why:
 *
 * - `oldest` — the walk back stopped before reaching the original revision, so
 *   the earliest revisions are not listed.
 * - `newest` — the file's last `startxref` did not point at a parseable
 *   cross-reference section, so an older entry point was used and whatever was
 *   appended last is not listed.
 *
 * Both can be absent at once. `missing` is empty **only** when `status` is
 * `complete`; when `status` is `unwalkable` both ends are named, because
 * nothing at all was read.
 */
export interface RevisionChainCoverage {
  status: 'complete' | 'partial' | 'unwalkable';
  missing: RevisionChainEnd[];
}

/** Which end of the revision history is absent from `revisions` */
export type RevisionChainEnd = 'oldest' | 'newest';

/**
 * How `revisionCount` (the `startxref` keywords) and `revisions.length` (the
 * cross-reference sections the chain reached) relate to each other.
 *
 * Derived in one place, for the reason `RevisionChainCoverage` is: a caller
 * that recombines `revisionCount`, `revisions.length` and the linearisation
 * flag to answer "is this difference explained" is a second source of truth
 * for the same fact.
 */
export interface RevisionCountAgreement {
  status: 'agree' | 'accounted' | 'unaccounted';
  causes: RevisionCountCause[];
}

/**
 * A fact read from the file that makes the two revision counts differ.
 *
 * - `linearised` — the file is linearised (ISO 32000-2 Annex F). Its
 *   first-page and main cross-reference sections belong to one save and were
 *   folded back into the one revision they describe, so one `startxref` has no
 *   revision of its own.
 * - `chain-incomplete` — the chain did not reach every section, so sections
 *   that exist are not listed. **Which end is absent is `revisionChain.missing`
 *   and is not repeated here.**
 */
export type RevisionCountCause = 'linearised' | 'chain-incomplete';

/** Which form of cross-reference section a revision used */
export type XrefKind = 'table' | 'stream' | 'hybrid';

/** Outcome of comparing later changes against the DocMDP permission */
export type DocMdpAssessment = 'permitted' | 'violated' | 'indeterminate';

/**
 * What kind of change an object represents, for DocMDP (ISO 32000-2 Table 257).
 *
 * The table talks about **kinds of change** ("filling in forms", "annotation
 * creation"), not about object types, so the mapping is this server's reading
 * of the clause and is stated as such:
 *
 * - `form-fill` — form fields and their widgets. Table 257 P=2: "filling in forms"
 * - `signature` — signature dictionaries, document timestamps, DSS. P=2: "signing"
 *   (and the P=1 DSS/DTS exception in the same row)
 * - `annotation` — a non-Widget annotation. P=3: "annotation creation, deletion,
 *   and modification"
 * - `housekeeping` — objects that a *permitted* change necessarily drags along:
 *   the page whose `/Annots` gained an entry, the catalog, the `/Info`
 *   dictionary, the XMP stream. Measured: a lawful P=3 annotation addition
 *   touches all four. Treating them as changes in their own right would make
 *   **every** certified document violate, which is not a usable reading
 * - `bookkeeping` — cross-reference and object streams; every save rewrites them
 * - `content` — the structure tree, fonts, XObjects, graphics state: changes no
 *   P value permits
 * - `unknown` — the object's kind could not be read. **Never folded into
 *   `housekeeping`**; it makes the assessment `indeterminate`.
 *
 * ⚠️ A bare stream (`<< /Length n >>` with no `/Type`) lands in `unknown`, not
 * `content`, and that is deliberate: the same bytes could be a form field's
 * appearance stream (which P=2 permits) or a page's content stream (which no P
 * permits). Reading it as `content` would report a violation that was not
 * shown; reading it as `housekeeping` would let a real one through.
 * "Not determined" is the only honest answer.
 */
export type DocMdpChangeClass =
  | 'form-fill'
  | 'signature'
  | 'annotation'
  | 'housekeeping'
  | 'bookkeeping'
  | 'content'
  | 'unknown';

/** One object written by a revision, relative to every older revision */
export interface RevisionObjectChange {
  objectNumber: number;
  generation: number;
  /**
   * - `added` — the object number was unused (or free) before this revision
   * - `modified` — an existing object was rewritten at a new offset
   * - `freed` — the object was marked free (deleted)
   */
  change: 'added' | 'modified' | 'freed';
  /** `/Type` as written in this revision, when it could be read */
  type: string | null;
  /** `/Subtype` as written in this revision, when present */
  subtype: string | null;
  /** Plain-language role, e.g. `annotation (Widget)`. `null` when unknown */
  role: string | null;
  /**
   * Machine-readable kind, for the DocMDP assessment. `role` is prose for a
   * reader; **this is what the rule reads** — a rule that string-matched
   * `role` would break the moment the wording is improved.
   */
  changeClass: DocMdpChangeClass;
  /**
   * true for cross-reference streams and object streams: file bookkeeping that
   * every incremental update rewrites, not a change to document content
   */
  bookkeeping: boolean;
  /**
   * true when the object lives inside an object stream. Its type is not read
   * (that would require inflating the container, which an encrypted file does
   * not permit here), so `type` / `role` stay null
   */
  inObjectStream: boolean;
}

/** One revision of the incremental-update chain, oldest first */
export interface RevisionSummary {
  /** 1-based; revision 1 is the original document */
  index: number;
  /** Byte offset of this revision's cross-reference section */
  xrefOffset: number;
  /** Byte offset just past this revision's `%%EOF`, when it was found */
  endOffset: number | null;
  xrefKind: XrefKind;
  /** Number of cross-reference entries this revision declares */
  objectCount: number;
  /** Total number of changed objects, before `changes` is capped */
  changeCount: number;
  /**
   * true when `changes` lists fewer than `changeCount` objects. A full rewrite
   * ("Save As" rather than an incremental update) can touch six figures of
   * objects; the listing keeps content objects and drops bookkeeping first.
   */
  changesTruncated: boolean;
  /** `null` for revision 1 — there is nothing older to diff against */
  changes: RevisionObjectChange[] | null;
  /**
   * Field names of the signatures whose signed range already ended when this
   * revision was appended. An observation about ordering, not a violation.
   */
  afterSignatures: (string | null)[];
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
