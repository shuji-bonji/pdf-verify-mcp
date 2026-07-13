/**
 * v0.5: Standard Security Handler decryption.
 *
 * - RC4 known-answer vector (cipher correctness)
 * - End-to-end: a hand-built RC4 (V1/R2, 40-bit) permission-encrypted PDF
 *   whose signature-dictionary strings are recovered by the parser.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { rc4 } from '../../src/services/decryptor.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function md5(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('md5');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** Build a minimal RC4 R2/V1 (40-bit) encrypted PDF with an encrypted /Reason. */
function buildEncryptedPdf(reason: string): Uint8Array {
  const id = new Uint8Array(16).fill(0x11);
  const permissions = -44; // arbitrary
  const permLe = new Uint8Array(4);
  new DataView(permLe.buffer).setInt32(0, permissions, true);

  // Algorithm 3: /O (owner password == user password == empty)
  const ownerKey = md5(PAD).subarray(0, 5);
  const o = rc4(ownerKey, PAD);

  // Algorithm 2: file key
  const fileKey = md5(PAD, o, permLe, id).subarray(0, 5);

  // Algorithm 4: /U (R2) = RC4(fileKey, PAD)
  const u = rc4(fileKey, PAD);

  // Per-object key for object 5 (the signature dict)
  const objNum = 5;
  const gen = 0;
  const extra = Uint8Array.from([objNum & 0xff, 0, 0, gen & 0xff, 0]);
  const objKey = md5(fileKey, extra).subarray(0, Math.min(fileKey.length + 5, 16));

  const reasonBytes = new TextEncoder().encode(reason);
  const encReason = rc4(objKey, reasonBytes);
  const encReasonHex = Buffer.from(encReason).toString('hex');
  const oHex = Buffer.from(o).toString('hex');
  const uHex = Buffer.from(u).toString('hex');
  const idHex = Buffer.from(id).toString('hex');

  const contents = `<${'0'.repeat(64)}>`;
  const objects: string[] = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /SigFlags 3 >> >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R] >>\nendobj\n`,
    `4 0 obj\n<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /P 3 0 R /V 5 0 R >>\nendobj\n`,
    `5 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 0 0 0] /Contents ${contents} /Reason <${encReasonHex}> >>\nendobj\n`,
    `6 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <${oHex}> /U <${uHex}> /P ${permissions} >>\nendobj\n`,
  ];

  const header = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  let body = header;
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += obj;
  }
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  const size = objects.length + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${size} /Root 1 0 R /Encrypt 6 0 R /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(body + xref + trailer, 'latin1'));
}

describe('rc4', () => {
  it('matches the standard RC4 known-answer vector', () => {
    const key = new TextEncoder().encode('Key');
    const plaintext = new TextEncoder().encode('Plaintext');
    const out = rc4(key, plaintext);
    expect(Buffer.from(out).toString('hex').toUpperCase()).toBe('BBF316E8D940AF0AD3');
  });

  it('is symmetric (decrypt(encrypt(x)) == x)', () => {
    const key = Uint8Array.from([1, 2, 3, 4, 5]);
    const data = new TextEncoder().encode('pdf-verify-mcp');
    expect(rc4(key, rc4(key, data))).toEqual(data);
  });
});

describe('Standard Security Handler decryption (RC4 R2)', () => {
  it('recovers an encrypted /Reason from a permission-encrypted PDF', async () => {
    const pdf = buildEncryptedPdf('Approved for release');
    const parsed = await parsePdfBytes(pdf);

    expect(parsed.isEncrypted).toBe(true);
    expect(parsed.decrypted).toBe(true);
    expect(parsed.signatures).toHaveLength(1);
    expect(parsed.signatures[0].reason).toBe('Approved for release');
  });
});
