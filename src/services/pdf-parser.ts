/**
 * PDF の構造を読む —— 署名辞書・DSS・XMP・リビジョン数。
 * 暗号はここに無い（cms-verifier.ts）。
 *
 * 入口は `openDocument`（document.ts）1 つで、そこが normativepdf と
 * 回復方針の両方を持つ。ここは**読んだものを family の語彙に移すだけ**であり、
 * COS の形を見るのは `cos.ts` に寄せてある。
 */

import { readFile } from 'node:fs/promises';
import type { CosDict, CosObject, PdfDocument } from 'normativepdf';
import type { ParsedPdf, SignatureField } from '../types.js';
import { assertReadablePdf, PdfVerifyError, toStructuralRefusal } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import {
  asArray,
  asDict,
  asStream,
  bytesOf,
  decodedBytes,
  enumerateObjects,
  get,
  has,
  integerOf,
  nameOf,
  numberOf,
  resolved,
  textOf,
} from './cos.js';
import { type DocumentScope, openDocument } from './document.js';

const CONTEXT = 'pdf-parser';

/** 数値の配列（1 つでも数値でなければ null —— 部分的な ByteRange は使えない）。 */
async function numberArray(
  doc: PdfDocument,
  dict: CosDict | null,
  key: string,
): Promise<number[] | null> {
  const array = asArray(await resolved(doc, get(dict, key)));
  if (!array) return null;
  const numbers: number[] = [];
  for (const item of array.items) {
    const n = numberOf(item);
    if (n === null) return null;
    numbers.push(n);
  }
  return numbers;
}

/**
 * Trim the zero padding a signer leaves in /Contents, **without cutting into the CMS itself**.
 *
 * The signature dictionary reserves a fixed-size /Contents and the producer pads whatever it
 * did not use with zero bytes, so the padding has to go. Removing every trailing zero is the
 * obvious way to do that and it is wrong: **a DER blob is allowed to end with 0x00**, and
 * roughly one signature in 256 does. Cutting that byte truncates the structure, `fromBER`
 * rejects it, and a perfectly valid signature is reported as unparseable — a false alarm in
 * exactly the direction that matters. (It first showed up as a test that failed once every
 * few hundred runs; the rate matches 1/256.)
 *
 * So take the length from the DER header instead of guessing from the tail: read the outer
 * SEQUENCE's tag and length, and cut where the structure says it ends. If the header does not
 * look like a CMS SEQUENCE (damaged input, or a form this parser does not know), fall back to
 * stripping zeros — a best-effort result beats refusing to look.
 */
function trimSignatureContents(bytes: Uint8Array): Uint8Array {
  const derLength = derTotalLength(bytes);
  if (derLength !== null) return bytes.subarray(0, derLength);

  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end);
}

/**
 * Total encoded length (header + content) of the DER object at the start of `bytes`,
 * or null when it is not a definite-length SEQUENCE that fits inside the buffer.
 */
function derTotalLength(bytes: Uint8Array): number | null {
  if (bytes.length < 2) return null;
  if (bytes[0] !== 0x30) return null; // CMS ContentInfo is a SEQUENCE

  const first = bytes[1];
  if (first < 0x80) return 2 + first; // short form
  if (first === 0x80) return null; // indefinite length — not valid DER
  const lengthBytes = first & 0x7f;
  if (lengthBytes > 4 || bytes.length < 2 + lengthBytes) return null;

  let contentLength = 0;
  for (let i = 0; i < lengthBytes; i++) {
    contentLength = contentLength * 256 + bytes[2 + i];
  }
  const total = 2 + lengthBytes + contentLength;
  return total <= bytes.length ? total : null;
}

/** Extract DocMDP permission from a signature dictionary's /Reference array */
async function extractDocMdpPermission(doc: PdfDocument, sigDict: CosDict): Promise<number | null> {
  const reference = asArray(await resolved(doc, get(sigDict, 'Reference')));
  if (!reference) return null;
  for (const item of reference.items) {
    const ref = asDict(await resolved(doc, item));
    if (!ref) continue;
    if (nameOf(await resolved(doc, get(ref, 'TransformMethod'))) !== 'DocMDP') continue;
    const params = asDict(await resolved(doc, get(ref, 'TransformParams')));
    if (params) {
      const p = integerOf(await resolved(doc, get(params, 'P')));
      if (p !== null) return p;
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
async function extractXmp(doc: PdfDocument, catalog: CosDict | null): Promise<string | null> {
  const stream = asStream(await resolved(doc, get(catalog, 'Metadata')));
  if (!stream) return null;
  const { bytes, unreadable } = await decodedBytes(doc, stream);
  if (bytes) return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // 復号できないストリームは、生バイトを読んでも意味を成さない。
  // 「XMP が無い」と「XMP を読めなかった」は別だが、ParsedPdf にはその区別が無いので
  // ここでは null にし、射程は scope が持つ。
  if (unreadable) logger.debug(CONTEXT, 'metadata stream could not be decoded');
  return null;
}

/** Decode an array of streams referenced from a DSS entry (Certs/OCSPs/CRLs) */
async function decodeStreamArray(
  doc: PdfDocument,
  dict: CosDict,
  key: string,
): Promise<Uint8Array[]> {
  const array = asArray(await resolved(doc, get(dict, key)));
  if (!array) return [];
  const results: Uint8Array[] = [];
  for (const item of array.items) {
    const stream = asStream(await resolved(doc, item));
    if (!stream) continue;
    const { bytes } = await decodedBytes(doc, stream);
    results.push(bytes ?? stream.raw);
  }
  return results;
}

/**
 * 署名フィールドの名前を、値が指すオブジェクト番号で引けるようにする。
 *
 * pdf-lib 版は辞書のオブジェクト同一性で対応づけていたが、normativepdf の
 * `getObject` は呼ぶたびに値を作るので同一性では引けない。参照の番号で引く。
 * `/V` が直接辞書の場合は引けない —— その形は AcroForm の署名では実質使われない。
 */
async function collectFieldNames(doc: PdfDocument): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  const { objects } = await enumerateObjects(doc);
  for (const { object } of objects) {
    const dict = asDict(object);
    if (!dict) continue;
    if (nameOf(await resolved(doc, get(dict, 'FT'))) !== 'Sig') continue;
    const fieldName = textOf(await resolved(doc, get(dict, 'T')));
    const value = get(dict, 'V');
    if (!fieldName || value === undefined) continue;
    if (value.kind === 'ref') names.set(value.objectNumber, fieldName);
  }
  return names;
}

export interface ParseOptions {
  /** Password for encrypted PDFs (empty string tries the user/permission key) */
  password?: string;
}

/**
 * Load the document the verify tools share. Recovery for files the library
 * refuses lives in `document.ts`; everything here reads the result.
 */
export async function loadPdfDocument(
  bytes: Uint8Array,
  options: ParseOptions = {},
): Promise<PdfDocument> {
  return (await openDocument(bytes, { password: options.password })).doc;
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
  let doc: PdfDocument;
  let scope: DocumentScope;
  try {
    ({ doc, scope } = await openDocument(bytes, { password: options.password }));
  } catch (error) {
    throw toStructuralRefusal(error);
  }

  // 暗号化文書は `openDocument` の時点で復号されている（§7.6）。復号できなければ
  // そこで条文を名指しして落ちるので、「読めたが暗号文のまま」という状態は無い
  // —— pdf-lib の ignoreEncryption はそれを作っていた。
  const isEncrypted = scope.encrypted;

  const catalog = asDict(await doc.getCatalog().catch(() => null));
  const fieldNames = await collectFieldNames(doc);
  const signatures: SignatureField[] = [];

  const { objects } = await enumerateObjects(doc);
  for (const { objectNumber, object } of objects) {
    const dict = asDict(object);
    if (!dict) continue;
    const type = nameOf(await resolved(doc, get(dict, 'Type')));
    const isSig = type === 'Sig';
    const isDts = type === 'DocTimeStamp';
    // Signature field widgets carry no ByteRange; require the shape.
    if (!has(dict, 'ByteRange') || !has(dict, 'Contents')) continue;
    if (!isSig && !isDts && !(has(dict, 'ByteRange') && has(dict, 'Contents'))) continue;

    const contents = bytesOf(get(dict, 'Contents'));
    signatures.push({
      fieldName: fieldNames.get(objectNumber) ?? null,
      filter: nameOf(await resolved(doc, get(dict, 'Filter'))),
      subFilter: nameOf(await resolved(doc, get(dict, 'SubFilter'))),
      byteRange: await numberArray(doc, dict, 'ByteRange'),
      contents: contents ? trimSignatureContents(contents) : null,
      signingTimeDictionary: textOf(await resolved(doc, get(dict, 'M'))),
      name: textOf(await resolved(doc, get(dict, 'Name'))),
      reason: textOf(await resolved(doc, get(dict, 'Reason'))),
      location: textOf(await resolved(doc, get(dict, 'Location'))),
      isDocumentTimestamp: isDts,
      docMdpPermission: await extractDocMdpPermission(doc, dict),
    });
  }

  // Sort signatures by their position in the file (end of signed range)
  signatures.sort((a, b) => {
    const endA = a.byteRange ? a.byteRange[2] + a.byteRange[3] : 0;
    const endB = b.byteRange ? b.byteRange[2] + b.byteRange[3] : 0;
    return endA - endB;
  });

  const dssEntry: CosObject | undefined = get(catalog, 'DSS');
  const dssDict = asDict(await resolved(doc, dssEntry));
  const parsed: ParsedPdf = {
    bytes,
    fileSize: bytes.length,
    isEncrypted,
    decrypted: scope.authenticated && isEncrypted,
    signatures,
    revisionCount: countPattern(bytes, 'startxref'),
    hasDss: dssEntry !== undefined,
    hasVri: dssDict ? has(dssDict, 'VRI') : false,
    dss: dssDict
      ? {
          certs: await decodeStreamArray(doc, dssDict, 'Certs'),
          ocsps: await decodeStreamArray(doc, dssDict, 'OCSPs'),
          crls: await decodeStreamArray(doc, dssDict, 'CRLs'),
        }
      : null,
    xmpMetadata: await extractXmp(doc, catalog),
    pdfVersion: doc.headerVersion,
    scope,
  };

  logger.debug(
    CONTEXT,
    `parsed: ${parsed.signatures.length} signature(s), ${parsed.revisionCount} revision(s)` +
      (scope.recovered ? ' (recovered)' : ''),
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
