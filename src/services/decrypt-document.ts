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
import type { PdfDecryptor } from './decryptor.js';
import { buildDecryptor } from './pdf-parser.js';

const CONTEXT = 'decrypt-document';

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
