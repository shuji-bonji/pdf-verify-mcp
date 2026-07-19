/**
 * PDF Standard Security Handler decryption (v0.5).
 *
 * Implements ISO 32000-1 §7.6.3 (RC4 / AES-128, R2–R4) and the PDF 2.0 /
 * Adobe extension algorithm 2.A (AES-256, R5/R6, ISO 32000-2 §7.6.4.3.4).
 *
 * Scope: decrypts individual strings and streams so the verification tools
 * can recover metadata (field name, /M, /Reason, /Location) and the XMP
 * stream from permission-encrypted or password-encrypted PDFs.
 *
 * Note: a signature's /Contents is exempt from encryption (ISO 32000-1
 * §7.6.2), so signature verification never depends on this module.
 */

import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

/** Padding string from ISO 32000-1, Algorithm 2 */
const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const AES_SALT = Uint8Array.from([0x73, 0x41, 0x6c, 0x54]); // "sAlT"

export type CryptMethod = 'RC4' | 'AESV2' | 'AESV3' | 'Identity';

export interface EncryptParams {
  /** Algorithm revision (2,3,4,5,6) */
  revision: number;
  /** Algorithm version (1,2,4,5) */
  version: number;
  /** File encryption key length in bytes */
  keyLength: number;
  /** /O entry bytes */
  o: Uint8Array;
  /** /U entry bytes */
  u: Uint8Array;
  /** /OE entry bytes (R6) */
  oe: Uint8Array | null;
  /** /UE entry bytes (R6) */
  ue: Uint8Array | null;
  /** /P permissions (signed 32-bit) */
  permissions: number;
  /** First element of the trailer /ID */
  idBytes: Uint8Array;
  /** Whether metadata is encrypted (default true) */
  encryptMetadata: boolean;
  /** Crypt method for streams */
  streamMethod: CryptMethod;
  /** Crypt method for strings */
  stringMethod: CryptMethod;
}

/** RC4 stream cipher (OpenSSL 3 disables RC4, so implement it directly) */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 0xff;
    b = (b + s[a]) & 0xff;
    [s[a], s[b]] = [s[b], s[a]];
    out[k] = data[k] ^ s[(s[a] + s[b]) & 0xff];
  }
  return out;
}

function md5(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash('md5');
  for (const p of parts) hash.update(p);
  return new Uint8Array(hash.digest());
}

/** Pad or truncate a password to 32 bytes per Algorithm 2 */
function padPassword(password: Uint8Array): Uint8Array {
  const result = new Uint8Array(32);
  const n = Math.min(password.length, 32);
  result.set(password.subarray(0, n), 0);
  result.set(PAD.subarray(0, 32 - n), n);
  return result;
}

function int32le(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setInt32(0, value, true);
  return buf;
}

/**
 * Derive the file encryption key for R2–R4 (Algorithm 2).
 * Only the user password path is implemented (empty by default).
 */
function computeKeyR234(params: EncryptParams, password: Uint8Array): Uint8Array {
  const padded = padPassword(password);
  const parts: Uint8Array[] = [
    padded,
    params.o.subarray(0, 32),
    int32le(params.permissions),
    params.idBytes,
  ];
  if (params.revision >= 4 && !params.encryptMetadata) {
    parts.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff]));
  }
  let key = md5(...parts);
  const n = params.keyLength;
  if (params.revision >= 3) {
    for (let i = 0; i < 50; i++) {
      key = md5(key.subarray(0, n));
    }
  }
  return key.subarray(0, n);
}

/**
 * Validate the user password for R2–R4 by reproducing /U (Algorithm 4/5)
 * from the derived file key and comparing against the stored /U.
 *
 * R2 (Algorithm 4): U = RC4(fileKey, PAD)
 * R3/R4 (Algorithm 5): U = RC4-19-rounds(RC4(fileKey, MD5(PAD + ID))),
 *   compared on the first 16 bytes (the trailing 16 are arbitrary salt).
 */
function validateUserPasswordR234(params: EncryptParams, key: Uint8Array): boolean {
  if (params.u.length < 16) return false;
  if (params.revision === 2) {
    return bytesEqual(rc4(key, PAD), params.u.subarray(0, 32));
  }
  // R3/R4
  let u = md5(PAD, params.idBytes);
  u = rc4(key, u);
  for (let i = 1; i <= 19; i++) {
    const k = Uint8Array.from(key, (b) => b ^ i);
    u = rc4(k, u);
  }
  return bytesEqual(u.subarray(0, 16), params.u.subarray(0, 16));
}

/**
 * Derive the file key for R6 (AES-256) from the empty/user password
 * (ISO 32000-2 Algorithm 2.A + 2.B).
 */
function computeKeyR6(params: EncryptParams, password: Uint8Array): Uint8Array | null {
  if (!params.ue) return null;
  const pw = password.subarray(0, 127);

  // Algorithm 2.B: iterated SHA-2 hash (ISO 32000-2 §7.6.4.3.4)
  const hash2B = (salt: Uint8Array, udata: Uint8Array): Uint8Array => {
    let k = new Uint8Array(createHash('sha256').update(pw).update(salt).update(udata).digest());
    for (let round = 0; ; round++) {
      const block = concat([pw, k, udata]);
      const k1Parts: Uint8Array[] = [];
      for (let i = 0; i < 64; i++) k1Parts.push(block);
      const k1 = concat(k1Parts);
      const e = aesCbcEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), k1);
      let mod = 0;
      for (let i = 0; i < 16; i++) mod += e[i];
      mod %= 3;
      const algo = mod === 0 ? 'sha256' : mod === 1 ? 'sha384' : 'sha512';
      k = new Uint8Array(createHash(algo).update(e).digest());
      // ISO 32000-2 Algorithm 2.B: run ≥64 rounds, then stop once the last
      // byte of E ≤ (round count) − 32. `round` is 0-indexed and this check
      // runs after the (round+1)-th iteration, so the threshold is round−31
      // (i.e. iterationCount−32), matching pdf.js / iText / mupdf.
      if (round >= 63 && e[e.length - 1] <= round - 31) break;
    }
    return k.subarray(0, 32);
  };

  // Validate user password: U = hash of (pw + validation salt)
  const validationSalt = params.u.subarray(32, 40);
  const keySalt = params.u.subarray(40, 48);
  const computed = hash2B(validationSalt, new Uint8Array(0));
  if (!bytesEqual(computed, params.u.subarray(0, 32))) {
    return null; // wrong password
  }
  const intermediate = hash2B(keySalt, new Uint8Array(0));
  // File key = AES-256-CBC (no padding, zero IV) decrypt of UE with intermediate key
  const decipher = createDecipheriv('aes-256-cbc', intermediate, new Uint8Array(16));
  decipher.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([decipher.update(params.ue), decipher.final()]));
}

/** AES-128-CBC encrypt without padding (needed by the R6 hash) */
function aesCbcEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([cipher.update(data), cipher.final()]));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A configured decryptor for a specific PDF */
export class PdfDecryptor {
  private readonly fileKey: Uint8Array;

  private constructor(
    private readonly params: EncryptParams,
    fileKey: Uint8Array,
  ) {
    this.fileKey = fileKey;
  }

  /** Build a decryptor; returns null when the password is wrong/unsupported */
  static create(params: EncryptParams, password = new Uint8Array(0)): PdfDecryptor | null {
    let key: Uint8Array | null;
    if (params.revision >= 5) {
      // computeKeyR6 already validates /U internally.
      key = computeKeyR6(params, password);
    } else {
      key = computeKeyR234(params, password);
      // Reject wrong passwords: without this a bad password still derives a
      // (garbage) key and would silently produce mojibake.
      if (key && !validateUserPasswordR234(params, key)) {
        key = null;
      }
    }
    if (!key) return null;
    return new PdfDecryptor(params, key);
  }

  /** Per-object key for RC4 / AESV2 (Algorithm 1). AESV3 uses the file key. */
  private objectKey(objNumber: number, generation: number, aes: boolean): Uint8Array {
    if (this.params.revision >= 5) return this.fileKey;
    const extra = Uint8Array.from([
      objNumber & 0xff,
      (objNumber >> 8) & 0xff,
      (objNumber >> 16) & 0xff,
      generation & 0xff,
      (generation >> 8) & 0xff,
    ]);
    const parts = [this.fileKey, extra];
    if (aes) parts.push(AES_SALT);
    const digest = md5(...parts);
    return digest.subarray(0, Math.min(this.fileKey.length + 5, 16));
  }

  private decryptWith(
    method: CryptMethod,
    data: Uint8Array,
    objNumber: number,
    generation: number,
  ): Uint8Array {
    if (method === 'Identity' || data.length === 0) return data;
    if (method === 'RC4') {
      return rc4(this.objectKey(objNumber, generation, false), data);
    }
    // AESV2 / AESV3: first 16 bytes are the IV
    if (data.length < 16) return data;
    const isAesV3 = method === 'AESV3';
    // AESV3 (AES-256) always uses the file key directly; AESV2 (AES-128)
    // uses the per-object key derived with the "sAlT" suffix.
    const key = isAesV3 ? this.fileKey : this.objectKey(objNumber, generation, true);
    const algo = isAesV3 ? 'aes-256-cbc' : 'aes-128-cbc';
    const requiredKeyLength = isAesV3 ? 32 : 16;
    // Key/algorithm length mismatch (e.g. a malformed AESV3 filter on an
    // R<5 document) — do not attempt: returning ciphertext-as-plaintext is
    // handled by the caller's mojibake guard rather than crashing here.
    if (key.length !== requiredKeyLength) return data;
    const iv = data.subarray(0, 16);
    const body = data.subarray(16);
    try {
      const decipher = createDecipheriv(algo, key, iv);
      // PKCS#7 padding is used by PDF AES
      return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
    } catch {
      return data;
    }
  }

  /** Whether the document's Metadata stream is encrypted (/EncryptMetadata) */
  get encryptsMetadata(): boolean {
    return this.params.encryptMetadata;
  }

  /** Decrypt a string value belonging to object (objNumber, generation) */
  decryptString(data: Uint8Array, objNumber: number, generation: number): Uint8Array {
    return this.decryptWith(this.params.stringMethod, data, objNumber, generation);
  }

  /** Decrypt a stream value belonging to object (objNumber, generation) */
  decryptStream(data: Uint8Array, objNumber: number, generation: number): Uint8Array {
    return this.decryptWith(this.params.streamMethod, data, objNumber, generation);
  }
}
