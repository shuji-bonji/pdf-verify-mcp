/**
 * Full-document decryption (Issue #7, v0.6.3).
 *
 * The v0.5 decryptor decrypts individual strings/streams on demand (enough for
 * signature metadata). Structural validation needs more: pdf-lib cannot parse
 * objects stored inside encrypted object streams, so rules like ua-struct-tree
 * see "no structure" where there is one.
 *
 * This service rebuilds a plaintext document in two passes:
 *   1. load with ignoreEncryption, decrypt every raw stream and string in the
 *      xref (object streams become readable Flate data), drop /Encrypt, save
 *   2. the caller re-parses the saved bytes — objects inside the now-plaintext
 *      object streams appear normally
 *
 * Per ISO 32000-2 §7.6.2 / §7.5.7-8: signature /Contents, cross-reference
 * streams, and strings inside object streams are never encrypted themselves —
 * those are skipped (the last is implicit: ObjStm contents are decrypted as a
 * stream, the strings inside were plaintext within it).
 */

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFInvalidObject,
  PDFName,
  PDFNumber,
  PDFObjectParser,
  PDFObjectStreamParser,
  PDFRawStream,
  PDFRef,
  PDFString,
  PDFWriter,
} from 'pdf-lib';
import { logger } from '../utils/logger.js';
import { type CryptMethod, type EncryptParams, PdfDecryptor } from './decryptor.js';

const CONTEXT = 'decrypt-document';

/* ------------------------------------------------------------------ *
 * 復号器の組み立て（pdf-lib の /Encrypt 辞書から）
 *
 * L2 で pdf-parser.ts は normativepdf に載り、復号はライブラリが持つようになった。
 * ここは pdf-lib のまま残っている最後の島（L4 で撤去可否を測る）なので、
 * このファイル専用の道具として引き取った。
 * ------------------------------------------------------------------ */

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

function lookupName(dict: PDFDict, key: string): string | null {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFName ? value.decodeText() : null;
}

function decryptedString(plain: Uint8Array): PDFHexString {
  return PDFHexString.of(Buffer.from(plain).toString('hex'));
}

/**
 * Decrypt strings nested (directly) in a container object. PDFRef children are
 * indirect objects handled by the top-level walk, so recursion stops there.
 * A /Contents value in a dictionary that carries /ByteRange is a signature's
 * CMS payload, which is excluded from encryption (§7.6.2) — left untouched.
 */
function decryptStringsIn(
  obj: unknown,
  ref: PDFRef,
  decryptor: PdfDecryptor,
  seen: Set<object>,
): void {
  if (obj instanceof PDFDict) {
    if (seen.has(obj)) return;
    seen.add(obj);
    const isSignature = obj.has(PDFName.of('ByteRange'));
    for (const [key, value] of obj.entries()) {
      if (isSignature && key.decodeText() === 'Contents') continue;
      if (value instanceof PDFString || value instanceof PDFHexString) {
        const plain = decryptor.decryptString(
          new Uint8Array(value.asBytes()),
          ref.objectNumber,
          ref.generationNumber,
        );
        obj.set(key, decryptedString(plain));
      } else {
        decryptStringsIn(value, ref, decryptor, seen);
      }
    }
  } else if (obj instanceof PDFArray) {
    if (seen.has(obj)) return;
    seen.add(obj);
    for (let i = 0; i < obj.size(); i++) {
      const value = obj.get(i);
      if (value instanceof PDFString || value instanceof PDFHexString) {
        const plain = decryptor.decryptString(
          new Uint8Array(value.asBytes()),
          ref.objectNumber,
          ref.generationNumber,
        );
        obj.set(i, decryptedString(plain));
      } else {
        decryptStringsIn(value, ref, decryptor, seen);
      }
    }
  }
}

/**
 * Rebuild an encrypted document as plaintext bytes.
 *
 * Returns null when the password is wrong or the security handler is
 * unsupported (the caller decides whether that is an error or "not checkable").
 * Returns the input unchanged when the document is not encrypted.
 */
export async function decryptDocumentBytes(
  bytes: Uint8Array,
  password: string,
): Promise<Uint8Array | null> {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
  if (!doc.isEncrypted) return bytes;

  const decryptor = buildDecryptor(doc, password);
  if (!decryptor) return null;

  const encRef = doc.context.trailerInfo.Encrypt;
  const seen = new Set<object>();

  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (encRef instanceof PDFRef && ref === encRef) continue;
    if (
      encRef instanceof PDFRef &&
      ref.objectNumber === encRef.objectNumber &&
      ref.generationNumber === encRef.generationNumber
    ) {
      continue; // the encryption dictionary itself is never encrypted
    }

    // Encrypted object streams fail pdf-lib's eager ObjStm expansion at load
    // time and land in the context as PDFInvalidObject carrying the raw
    // bytes ("<< dict >> stream ... endstream"). Re-parse them as a plain
    // stream (no expansion) so their contents can be decrypted; the caller's
    // re-parse of the plaintext bytes expands them normally.
    let effective = obj;
    if (obj instanceof PDFInvalidObject) {
      try {
        const data = (obj as unknown as { data: Uint8Array }).data;
        const reparsed = PDFObjectParser.forBytes(data, doc.context).parseObject();
        if (reparsed instanceof PDFRawStream) effective = reparsed;
      } catch {
        continue; // leave the invalid object untouched
      }
    }

    if (effective instanceof PDFRawStream) {
      const stream = effective;
      const typeVal = stream.dict.lookup(PDFName.of('Type'));
      const typeName = typeVal instanceof PDFName ? typeVal.decodeText() : null;
      if (typeName === 'XRef') continue; // §7.5.8.2: never encrypted
      if (typeName === 'Metadata' && !decryptor.encryptsMetadata) {
        continue; // /EncryptMetadata false: metadata stream is plaintext
      }
      const plain = decryptor.decryptStream(
        stream.getContents(),
        ref.objectNumber,
        ref.generationNumber,
      );
      const dict = stream.dict;
      dict.set(PDFName.of('Length'), PDFNumber.of(plain.length));
      decryptStringsIn(dict, ref, decryptor, seen);
      const plainStream = PDFRawStream.of(dict, plain);

      if (typeName === 'ObjStm') {
        // Expand the decrypted object stream into plain indirect objects and
        // drop the ObjStm itself. Leaving it as an opaque stream would write
        // an xref with no entries for the contained objects — pdf-lib is
        // lenient about that, but qpdf/veraPDF correctly reject it.
        try {
          await PDFObjectStreamParser.forStream(plainStream).parseIntoContext();
          doc.context.delete(ref);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(CONTEXT, `failed to expand decrypted ObjStm ${ref.toString()}: ${message}`);
          doc.context.assign(ref, plainStream); // keep the stream as-is
        }
      } else {
        doc.context.assign(ref, plainStream);
      }
    } else {
      decryptStringsIn(effective, ref, decryptor, seen);
    }
  }

  // Drop /Encrypt so the rebuilt file is a plain PDF
  delete doc.context.trailerInfo.Encrypt;

  // Serialize the raw context directly. PDFDocument.save() walks the page
  // tree, which lives inside the (freshly decrypted, not yet re-expanded)
  // object streams — PDFWriter does not need it.
  try {
    return await PDFWriter.forContext(doc.context, 50).serializeToBuffer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(CONTEXT, `failed to serialize decrypted document: ${message}`);
    return null;
  }
}
