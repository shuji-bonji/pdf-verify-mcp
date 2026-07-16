/**
 * v0.5.1: end-to-end decryption of real qpdf-generated encrypted PDFs.
 *
 * Covers AES-256 (R6), AES-128 (R4) and RC4 (R3) permission encryption, plus
 * the wrong-password regression for the R2–R4 /U validation fix (review #1).
 *
 * Skips automatically when qpdf is not installed. CI installs it via apt.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parsePdf } from '../../src/services/pdf-parser.js';
import { createSignedPdf, createTestIdentity } from '../helpers/signed-pdf.js';

function qpdfAvailable(): boolean {
  try {
    execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasQpdf = qpdfAvailable();
const describeQpdf = hasQpdf ? describe : describe.skip;

let dir: string;

beforeAll(async () => {
  if (!hasQpdf) return;
  const identity = await createTestIdentity();
  const plain = await createSignedPdf(identity, { xmp: { pdfaPart: '2', pdfaConformance: 'B' } });
  dir = await mkdtemp(join(tmpdir(), 'pdf-verify-qpdf-'));
  await writeFile(join(dir, 'plain.pdf'), plain);

  const run = (args: string[]) => execFileSync('qpdf', args, { cwd: dir });
  // Permission-encrypted (empty user password) in three cipher generations
  run(['--encrypt', '', '', '256', '--', 'plain.pdf', 'aes256.pdf']); // R6
  run(['--encrypt', '', 'owner', '128', '--use-aes=y', '--', 'plain.pdf', 'aes128.pdf']); // R4
  run([
    '--allow-weak-crypto',
    '--encrypt',
    '',
    '',
    '128',
    '--use-aes=n',
    '--',
    'plain.pdf',
    'rc4.pdf',
  ]); // R3
  // Password-required (non-empty user password) across revisions.
  // RC4 (R3) and AES-128 (R4) exercise the review #1 fix specifically — the
  // R2–R4 /U validation path. AES-256 (R6) already validated /U before the fix.
  run([
    '--allow-weak-crypto',
    '--encrypt',
    'secret',
    'owner',
    '128',
    '--use-aes=n',
    '--',
    'plain.pdf',
    'rc4pw.pdf',
  ]);
  run(['--encrypt', 'secret', 'owner', '128', '--use-aes=y', '--', 'plain.pdf', 'aes128pw.pdf']);
  run(['--encrypt', 'secret', 'owner', '256', '--', 'plain.pdf', 'aes256pw.pdf']);
});

describeQpdf('qpdf-generated encrypted PDFs (permission-encrypted)', () => {
  it.each(['aes256', 'aes128', 'rc4'])('decrypts %s and recovers string metadata', async (name) => {
    const parsed = await parsePdf(join(dir, `${name}.pdf`));
    expect(parsed.isEncrypted).toBe(true);
    expect(parsed.decrypted).toBe(true);
    expect(parsed.signatures[0]?.reason).toBe('Unit test');
  });
});

describeQpdf('password validation (review #1: R2–R4 /U check)', () => {
  it.each(['rc4pw', 'aes128pw', 'aes256pw'])(
    '%s: correct password decrypts, wrong/missing password is rejected',
    async (name) => {
      const path = join(dir, `${name}.pdf`);
      expect((await parsePdf(path, { password: 'secret' })).decrypted).toBe(true);
      // Without the /U validation fix, R2–R4 (rc4pw / aes128pw) would return
      // decrypted=true here and emit mojibake.
      expect((await parsePdf(path, { password: 'WRONG' })).decrypted).toBe(false);
      expect((await parsePdf(path)).decrypted).toBe(false);
    },
  );
});
