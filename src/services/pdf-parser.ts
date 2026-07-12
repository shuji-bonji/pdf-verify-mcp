/**
 * PDF structure parsing service.
 *
 * Extracts signature dictionaries, revision info, DSS and XMP metadata
 * using pdf-lib. No cryptography here — see cms-verifier.ts.
 */

import { readFile } from 'node:fs/promises';
import {
  decodePDFRawStream,
  PDFArray,
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

const CONTEXT = 'pdf-parser';

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
function extractXmp(doc: PDFDocument): string | null {
  const metadataRef = doc.catalog.get(PDFName.of('Metadata'));
  if (!metadataRef) return null;
  const stream = doc.context.lookup(metadataRef);
  if (!(stream instanceof PDFRawStream)) return null;
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

/**
 * Build a map from signature /V dictionaries to their field names,
 * by scanning all AcroForm signature fields.
 */
function collectFieldNames(doc: PDFDocument): Map<PDFDict, string> {
  const names = new Map<PDFDict, string>();
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (lookupName(object, 'FT') !== 'Sig') continue;
    const fieldName = lookupString(object, 'T');
    const v = object.get(PDFName.of('V'));
    if (!fieldName || !v) continue;
    const target = v instanceof PDFRef ? doc.context.lookup(v) : v;
    if (target instanceof PDFDict) {
      names.set(target, fieldName);
    }
  }
  return names;
}

/**
 * Parse a PDF file and extract everything the verification tools need.
 */
export async function parsePdf(filePath: string): Promise<ParsedPdf> {
  await assertReadablePdf(filePath);
  const buffer = await readFile(filePath);
  const bytes = new Uint8Array(buffer);
  return parsePdfBytes(bytes);
}

/** Parse from in-memory bytes (used by tests) */
export async function parsePdfBytes(bytes: Uint8Array): Promise<ParsedPdf> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      updateMetadata: false,
      ignoreEncryption: true,
      throwOnInvalidObject: false,
    });
  } catch (error) {
    throw new PdfVerifyError(
      `Failed to parse PDF: ${error instanceof Error ? error.message : String(error)}`,
      'PARSE_FAILED',
      'Verify the file is a well-formed PDF; encrypted or damaged files may not be parseable',
    );
  }

  const fieldNames = collectFieldNames(doc);
  const signatures: SignatureField[] = [];
  const seen = new Set<PDFDict>();

  for (const [, object] of doc.context.enumerateIndirectObjects()) {
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

    const contents = lookupBytes(object, 'Contents');
    signatures.push({
      fieldName: fieldNames.get(object) ?? null,
      filter: lookupName(object, 'Filter'),
      subFilter: lookupName(object, 'SubFilter'),
      byteRange: lookupNumberArray(object, 'ByteRange'),
      contents: contents ? stripZeroPadding(contents) : null,
      signingTimeDictionary: lookupString(object, 'M'),
      name: lookupString(object, 'Name'),
      reason: lookupString(object, 'Reason'),
      location: lookupString(object, 'Location'),
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
  if (dss) {
    const dssDict = doc.context.lookup(dss);
    if (dssDict instanceof PDFDict) {
      hasVri = dssDict.has(PDFName.of('VRI'));
    }
  }

  const headerMatch = /%PDF-(\d+\.\d+)/.exec(
    new TextDecoder('latin1').decode(bytes.subarray(0, 64)),
  );

  const parsed: ParsedPdf = {
    bytes,
    fileSize: bytes.length,
    signatures,
    revisionCount: countPattern(bytes, 'startxref'),
    hasDss: Boolean(dss),
    hasVri,
    xmpMetadata: extractXmp(doc),
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
