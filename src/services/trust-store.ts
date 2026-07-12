/**
 * Trust anchor loading.
 *
 * Anchors come from two sources, merged:
 * 1. Explicit file paths passed to the tool (`trust_anchors` parameter)
 * 2. The PDF_VERIFY_TRUST_ANCHORS environment variable (a directory whose
 *    *.pem / *.crt / *.cer / *.der files are all loaded)
 *
 * Both PEM (one or more CERTIFICATE blocks) and raw DER files are accepted.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { TRUST_ANCHORS_ENV } from '../constants.js';
import { logger } from '../utils/logger.js';

const CONTEXT = 'trust-store';

const CERT_EXTENSIONS = new Set(['.pem', '.crt', '.cer', '.der']);
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----/g;

export interface TrustStore {
  certificates: pkijs.Certificate[];
  /** Files successfully loaded */
  sources: string[];
  /** Files that could not be parsed */
  errors: string[];
}

function parseDerCertificate(der: Uint8Array): pkijs.Certificate | null {
  try {
    const asn1 = asn1js.fromBER(
      der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer,
    );
    if (asn1.offset === -1) return null;
    return new pkijs.Certificate({ schema: asn1.result });
  } catch {
    return null;
  }
}

/** Parse a file that may contain PEM blocks or a single DER certificate */
function parseCertificateFile(bytes: Buffer): pkijs.Certificate[] {
  const text = bytes.toString('latin1');
  if (text.includes('-----BEGIN CERTIFICATE-----')) {
    const certs: pkijs.Certificate[] = [];
    for (const match of text.matchAll(PEM_BLOCK)) {
      const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
      const cert = parseDerCertificate(new Uint8Array(der));
      if (cert) certs.push(cert);
    }
    return certs;
  }
  const cert = parseDerCertificate(new Uint8Array(bytes));
  return cert ? [cert] : [];
}

async function collectEnvPaths(): Promise<string[]> {
  const dir = process.env[TRUST_ANCHORS_ENV];
  if (!dir) return [];
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return [dir];
    const entries = await readdir(dir);
    return entries
      .filter((name) => CERT_EXTENSIONS.has(extname(name).toLowerCase()))
      .map((name) => join(dir, name));
  } catch {
    logger.warn(CONTEXT, `${TRUST_ANCHORS_ENV} points to an unreadable path: ${dir}`);
    return [];
  }
}

/** Load trust anchors from explicit paths plus the environment directory */
export async function loadTrustAnchors(paths: string[] = []): Promise<TrustStore> {
  const allPaths = [...paths, ...(await collectEnvPaths())];
  const store: TrustStore = { certificates: [], sources: [], errors: [] };

  for (const path of allPaths) {
    try {
      const bytes = await readFile(path);
      const certs = parseCertificateFile(bytes);
      if (certs.length === 0) {
        store.errors.push(`${path}: no certificate found (expected PEM or DER)`);
        continue;
      }
      store.certificates.push(...certs);
      store.sources.push(path);
    } catch (error) {
      store.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logger.debug(
    CONTEXT,
    `loaded ${store.certificates.length} anchor(s) from ${store.sources.length} file(s)`,
  );
  return store;
}
