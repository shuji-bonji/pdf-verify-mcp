/**
 * PDF structure parsing service.
 *
 * Extracts signature dictionaries, revision info, DSS and XMP metadata
 * using pdf-lib. No cryptography here — see cms-verifier.ts.
 */

import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import {
  decodePDFRawStream,
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import type { ParsedPdf, SignatureField } from '../types.js';
import { assertReadablePdf, PdfVerifyError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import { type CryptMethod, type EncryptParams, PdfDecryptor } from './decryptor.js';

const CONTEXT = 'pdf-parser';

/** Map a crypt filter's CFM to our method enum */
function cfmToMethod(cfm: string | null): CryptMethod {
  switch (cfm) {
    case 'V2':
      return 'RC4';
    case 'AESV2':
      return 'AESV2';
    case 'AESV3':
      return 'AESV3';
    case 'Identity':
      return 'Identity';
    default:
      return 'RC4';
  }
}

/** Build a decryptor from the trailer /Encrypt dictionary (v0.5) */
export function buildDecryptor(doc: PDFDocument, password: string): PdfDecryptor | null {
  const encRef = doc.context.trailerInfo.Encrypt;
  if (!encRef) return null;
  const enc = doc.context.lookup(encRef);
  if (!(enc instanceof PDFDict)) return null;
  if (lookupName(enc, 'Filter') !== 'Standard') {
    logger.warn(CONTEXT, 'Non-standard security handler is not supported');
    return null;
  }

  const numberOf = (key: string, fallback: number): number => {
    const v = enc.get(PDFName.of(key));
    return v instanceof PDFNumber ? v.asNumber() : fallback;
  };
  const bytesOf = (key: string): Uint8Array => {
    const v = enc.lookup(PDFName.of(key));
    return v instanceof PDFString || v instanceof PDFHexString
      ? new Uint8Array(v.asBytes())
      : new Uint8Array(0);
  };

  const version = numberOf('V', 0);
  const revision = numberOf('R', 0);
  const keyLength = Math.floor(numberOf('Length', 40) / 8);

  // V4/V5 use crypt filters (CF/StmF/StrF); V1/V2 use RC4 directly.
  let streamMethod: CryptMethod = 'RC4';
  let stringMethod: CryptMethod = 'RC4';
  if (version >= 4) {
    const cf = enc.lookup(PDFName.of('CF'));
    const resolveCfm = (filterName: string | null): CryptMethod => {
      if (!filterName || filterName === 'Identity') return 'Identity';
      if (cf instanceof PDFDict) {
        const entry = cf.lookup(PDFName.of(filterName));
        if (entry instanceof PDFDict) return cfmToMethod(lookupName(entry, 'CFM'));
      }
      return 'RC4';
    };
    streamMethod = resolveCfm(lookupName(enc, 'StmF'));
    stringMethod = resolveCfm(lookupName(enc, 'StrF'));
  }
  // R5/R6 are always AES-256 regardless of the declared filters.
  if (revision >= 5) {
    streamMethod = 'AESV3';
    stringMethod = 'AESV3';
  }

  const idArray = doc.context.trailerInfo.ID;
  let idBytes = new Uint8Array(0);
  if (idArray instanceof PDFArray && idArray.size() > 0) {
    const first = idArray.lookup(0);
    if (first instanceof PDFString || first instanceof PDFHexString)
      idBytes = new Uint8Array(first.asBytes());
  }

  const encryptMetadataVal = enc.get(PDFName.of('EncryptMetadata'));
  const encryptMetadata =
    encryptMetadataVal instanceof PDFBool ? encryptMetadataVal.asBoolean() : true;

  const params: EncryptParams = {
    revision,
    version,
    keyLength: keyLength > 0 ? keyLength : 5,
    o: bytesOf('O'),
    u: bytesOf('U'),
    oe: revision >= 5 ? bytesOf('OE') : null,
    ue: revision >= 5 ? bytesOf('UE') : null,
    permissions: numberOf('P', 0),
    idBytes,
    encryptMetadata,
    streamMethod,
    stringMethod,
  };

  const decryptor = PdfDecryptor.create(params, new TextEncoder().encode(password));
  if (!decryptor) {
    logger.warn(CONTEXT, 'Failed to derive decryption key (wrong password or unsupported handler)');
  }
  return decryptor;
}

/** Decode raw PDF string bytes: UTF-16BE (with BOM) or PDFDocEncoding-ish */
function decodePdfStringBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2));
    if (body.length % 2 === 0) {
      const swapped = Buffer.from(body);
      swapped.swap16(); // UTF-16BE → LE
      return swapped.toString('utf16le');
    }
  }
  return Buffer.from(bytes).toString('latin1');
}

function lookupName(dict: PDFDict, key: string): string | null {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFName ? value.decodeText() : null;
}

function lookupString(dict: PDFDict, key: string): string | null {
  const value = dict.lookup(PDFName.of(key));
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return value.decodeText();
  }
  return null;
}

function lookupBytes(dict: PDFDict, key: string): Uint8Array | null {
  const value = dict.lookup(PDFName.of(key));
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return value.asBytes();
  }
  return null;
}

function lookupNumberArray(dict: PDFDict, key: string): number[] | null {
  const value = dict.lookup(PDFName.of(key));
  if (!(value instanceof PDFArray)) return null;
  const numbers: number[] = [];
  for (let i = 0; i < value.size(); i++) {
    const item = value.lookup(i);
    if (!(item instanceof PDFNumber)) return null;
    numbers.push(item.asNumber());
  }
  return numbers;
}

/** Strip trailing zero-byte padding from /Contents */
function stripZeroPadding(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end);
}

/** Extract DocMDP permission from a signature dictionary's /Reference array */
function extractDocMdpPermission(sigDict: PDFDict): number | null {
  const reference = sigDict.lookup(PDFName.of('Reference'));
  if (!(reference instanceof PDFArray)) return null;
  for (let i = 0; i < reference.size(); i++) {
    const ref = reference.lookup(i);
    if (!(ref instanceof PDFDict)) continue;
    if (lookupName(ref, 'TransformMethod') !== 'DocMDP') continue;
    const params = ref.lookup(PDFName.of('TransformParams'));
    if (params instanceof PDFDict) {
      const p = params.lookup(PDFName.of('P'));
      if (p instanceof PDFNumber) return p.asNumber();
    }
    return 2; // DocMDP default permission (ISO 32000-1 Table 254)
  }
  return null;
}

/** Count occurrences of a byte pattern in a buffer */
function countPattern(haystack: Uint8Array, pattern: string): number {
  const needle = new TextEncoder().encode(pattern);
  let count = 0;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    count++;
    i += needle.length - 1;
  }
  return count;
}

/** Extract XMP metadata stream text from the document catalog */
function extractXmp(doc: PDFDocument, decryptor: PdfDecryptor | null): string | null {
  const metadataRef = doc.catalog.get(PDFName.of('Metadata'));
  if (!metadataRef) return null;
  const stream = doc.context.lookup(metadataRef);
  if (!(stream instanceof PDFRawStream)) return null;

  // Encrypted PDFs: decrypt the stream bytes first (metadata object number
  // comes from the indirect reference), then apply stream filters.
  if (decryptor && metadataRef instanceof PDFRef) {
    try {
      let raw = decryptor.decryptStream(
        stream.contents,
        metadataRef.objectNumber,
        metadataRef.generationNumber,
      );
      const filter = lookupName(stream.dict, 'Filter');
      if (filter === 'FlateDecode') raw = new Uint8Array(inflateSync(raw));
      return new TextDecoder('utf-8', { fatal: false }).decode(raw);
    } catch {
      // fall through to the non-encrypted path
    }
  }

  try {
    const decoded = decodePDFRawStream(stream).decode();
    return new TextDecoder('utf-8', { fatal: false }).decode(decoded);
  } catch {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(stream.contents);
    } catch {
      return null;
    }
  }
}

/** Decode an array of streams referenced from a DSS entry (Certs/OCSPs/CRLs) */
function decodeStreamArray(dict: PDFDict, key: string): Uint8Array[] {
  const array = dict.lookup(PDFName.of(key));
  if (!(array instanceof PDFArray)) return [];
  const results: Uint8Array[] = [];
  for (let i = 0; i < array.size(); i++) {
    const stream = array.lookup(i);
    if (!(stream instanceof PDFRawStream)) continue;
    try {
      results.push(decodePDFRawStream(stream).decode());
    } catch {
      results.push(stream.contents);
    }
  }
  return results;
}

/** Decrypt (when needed) and decode a string entry owned by an object */
function readString(
  dict: PDFDict,
  key: string,
  decryptor: PdfDecryptor | null,
  objNumber: number,
  generation: number,
): string | null {
  if (!decryptor) return lookupString(dict, key);
  const raw = lookupBytes(dict, key);
  if (!raw) return null;
  return decodePdfStringBytes(decryptor.decryptString(raw, objNumber, generation));
}

/**
 * Build a map from signature /V dictionaries to their field names,
 * by scanning all AcroForm signature fields. Decrypts /T when needed.
 */
function collectFieldNames(doc: PDFDocument, decryptor: PdfDecryptor | null): Map<PDFDict, string> {
  const names = new Map<PDFDict, string>();
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (lookupName(object, 'FT') !== 'Sig') continue;
    const fieldName = readString(object, 'T', decryptor, ref.objectNumber, ref.generationNumber);
    const v = object.get(PDFName.of('V'));
    if (!fieldName || !v) continue;
    const target = v instanceof PDFRef ? doc.context.lookup(v) : v;
    if (target instanceof PDFDict) {
      names.set(target, fieldName);
    }
  }
  return names;
}

export interface ParseOptions {
  /** Password for encrypted PDFs (empty string tries the user/permission key) */
  password?: string;
}

/**
 * Load a PDFDocument with the options shared across the verify tools:
 * metadata untouched, encryption tolerated, damaged objects skipped.
 * Centralised so parsing and native conformance validation stay consistent.
 */
export async function loadPdfDocument(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
}

/**
 * Parse a PDF file and extract everything the verification tools need.
 */
export async function parsePdf(filePath: string, options: ParseOptions = {}): Promise<ParsedPdf> {
  await assertReadablePdf(filePath);
  const buffer = await readFile(filePath);
  const bytes = new Uint8Array(buffer);
  return parsePdfBytes(bytes, options);
}

/** Parse from in-memory bytes (used by tests) */
export async function parsePdfBytes(
  bytes: Uint8Array,
  options: ParseOptions = {},
): Promise<ParsedPdf> {
  let doc: PDFDocument;
  try {
    doc = await loadPdfDocument(bytes);
  } catch (error) {
    throw new PdfVerifyError(
      `Failed to parse PDF: ${error instanceof Error ? error.message : String(error)}`,
      'PARSE_FAILED',
      'Verify the file is a well-formed PDF; encrypted or damaged files may not be parseable',
    );
  }

  // In encrypted PDFs all string/stream objects are encrypted. v0.5 attempts
  // decryption (permission-encrypted PDFs use an empty user password; a
  // password can be supplied for reader-encrypted PDFs). Signature /Contents
  // is exempt from encryption (ISO 32000-1 §7.6.2), so verification is
  // unaffected either way.
  const isEncrypted = doc.isEncrypted;
  const decryptor = isEncrypted ? buildDecryptor(doc, options.password ?? '') : null;
  const decrypted = decryptor !== null;

  const fieldNames = collectFieldNames(doc, decryptor);
  const signatures: SignatureField[] = [];
  const seen = new Set<PDFDict>();

  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || seen.has(object)) continue;
    const type = lookupName(object, 'Type');
    const isSig = type === 'Sig';
    const isDts = type === 'DocTimeStamp';
    const hasSignatureShape =
      object.has(PDFName.of('ByteRange')) && object.has(PDFName.of('Contents'));
    if (!isSig && !isDts && !hasSignatureShape) continue;
    // Signature field widgets also carry no ByteRange; require the shape.
    if (!hasSignatureShape) continue;
    seen.add(object);

    const objNum = ref.objectNumber;
    const gen = ref.generationNumber;
    // When encrypted but undecryptable, suppress mojibake by returning null.
    const str = (key: string): string | null =>
      isEncrypted && !decryptor ? null : readString(object, key, decryptor, objNum, gen);

    const contents = lookupBytes(object, 'Contents');
    signatures.push({
      fieldName: isEncrypted && !decryptor ? null : (fieldNames.get(object) ?? null),
      filter: lookupName(object, 'Filter'),
      subFilter: lookupName(object, 'SubFilter'),
      byteRange: lookupNumberArray(object, 'ByteRange'),
      contents: contents ? stripZeroPadding(contents) : null,
      signingTimeDictionary: str('M'),
      name: str('Name'),
      reason: str('Reason'),
      location: str('Location'),
      isDocumentTimestamp: isDts,
      docMdpPermission: extractDocMdpPermission(object),
    });
  }

  // Sort signatures by their position in the file (end of signed range)
  signatures.sort((a, b) => {
    const endA = a.byteRange ? a.byteRange[2] + a.byteRange[3] : 0;
    const endB = b.byteRange ? b.byteRange[2] + b.byteRange[3] : 0;
    return endA - endB;
  });

  const dss = doc.catalog.get(PDFName.of('DSS'));
  let hasVri = false;
  let dssStreams: ParsedPdf['dss'] = null;
  if (dss) {
    const dssDict = doc.context.lookup(dss);
    if (dssDict instanceof PDFDict) {
      hasVri = dssDict.has(PDFName.of('VRI'));
      dssStreams = {
        certs: decodeStreamArray(dssDict, 'Certs'),
        ocsps: decodeStreamArray(dssDict, 'OCSPs'),
        crls: decodeStreamArray(dssDict, 'CRLs'),
      };
    }
  }

  const headerMatch = /%PDF-(\d+\.\d+)/.exec(
    new TextDecoder('latin1').decode(bytes.subarray(0, 64)),
  );

  const parsed: ParsedPdf = {
    bytes,
    fileSize: bytes.length,
    isEncrypted,
    decrypted,
    signatures,
    revisionCount: countPattern(bytes, 'startxref'),
    hasDss: Boolean(dss),
    hasVri,
    dss: dssStreams,
    xmpMetadata: extractXmp(doc, decryptor),
    pdfVersion: headerMatch ? headerMatch[1] : null,
  };

  logger.debug(
    CONTEXT,
    `parsed: ${parsed.signatures.length} signature(s), ${parsed.revisionCount} revision(s)`,
  );
  return parsed;
}

/** Concatenate the bytes covered by a ByteRange */
export function extractSignedBytes(bytes: Uint8Array, byteRange: number[]): Uint8Array {
  if (byteRange.length !== 4) {
    throw new PdfVerifyError(
      `Invalid ByteRange: expected 4 numbers, got ${byteRange.length}`,
      'INVALID_BYTE_RANGE',
    );
  }
  const [o1, l1, o2, l2] = byteRange;
  if (o1 < 0 || l1 < 0 || o2 < 0 || l2 < 0 || o1 + l1 > bytes.length || o2 + l2 > bytes.length) {
    throw new PdfVerifyError(
      `ByteRange out of bounds for file of ${bytes.length} bytes`,
      'INVALID_BYTE_RANGE',
    );
  }
  const result = new Uint8Array(l1 + l2);
  result.set(bytes.subarray(o1, o1 + l1), 0);
  result.set(bytes.subarray(o2, o2 + l2), l1);
  return result;
}

/** Whether a ByteRange covers the whole file except the /Contents gap */
export function coversEntireFile(fileSize: number, byteRange: number[]): boolean {
  if (byteRange.length !== 4) return false;
  const [o1, l1, o2, l2] = byteRange;
  return o1 === 0 && o2 + l2 === fileSize && o2 >= l1;
}
