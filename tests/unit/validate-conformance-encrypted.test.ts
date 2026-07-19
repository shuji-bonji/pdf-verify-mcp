/**
 * Issue #7: PDF/UA validation of encrypted documents.
 *
 * Before v0.6.3, an encrypted document's unreadable structures produced false
 * definitive failures (ua-struct-tree "No /StructTreeRoot" on a tagged
 * document). Now the document is decrypted first (empty user password is
 * tried automatically; `password` covers the rest), and when decryption is
 * impossible, structure-dependent rules are reported as skipped, not failed.
 *
 * Fixtures are produced with qpdf; skips automatically when not installed.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ValidationEngine } from '../../src/constants.js';
import { validateConformance } from '../../src/services/conformance-validation.js';
import { parsePdf } from '../../src/services/pdf-parser.js';
import { buildUaPdf } from '../helpers/ua-pdf.js';

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

async function validate(file: string, password?: string) {
  const path = join(dir, file);
  const parsed = await parsePdf(path, { password });
  return validateConformance(parsed, path, {
    flavour: 'pdfua-1',
    engine: ValidationEngine.NATIVE,
    ...(password !== undefined ? { password } : {}),
  });
}

describeQpdf('PDF/UA validation of encrypted documents (Issue #7)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdf-verify-enc-ua-'));
    // A fully conformant tagged document (12/12 rules pass unencrypted)
    await writeFile(join(dir, 'plain.pdf'), await buildUaPdf());

    const run = (args: string[]) => execFileSync('qpdf', args, { cwd: dir });
    // Permission-encrypted (empty user password), accessibility allowed
    run(['--encrypt', '', 'owner', '256', '--', 'plain.pdf', 'perm.pdf']);
    // Accessibility bit cleared (only representable at 128-bit RC4)
    run([
      '--allow-weak-crypto',
      '--encrypt',
      '',
      'owner',
      '128',
      '--accessibility=n',
      '--',
      'plain.pdf',
      'noaccess.pdf',
    ]);
    // Password-required (non-empty user password)
    run(['--encrypt', 'secret', 'owner', '256', '--', 'plain.pdf', 'pw.pdf']);
  });

  it('auto-decrypts permission-encrypted documents and checks every rule', async () => {
    const report = await validate('perm.pdf');
    expect(report.skippedRules).toBeUndefined();
    expect(report.checkedRules).toBe(12);
    expect(report.violations).toEqual([]); // no false structure failures
    expect(report.compliant).toBeNull();
    expect(report.notes.join(' ')).toMatch(/decrypted before validation/);
  });

  it('judges the original /Encrypt /P even after decryption (7.16)', async () => {
    const report = await validate('noaccess.pdf');
    const ids = report.violations.map((v) => v.ruleId);
    expect(ids).toEqual(['ua-no-encryption-barrier']); // and nothing else
    expect(report.violations[0].detail).toMatch(/bit 10/);
    expect(report.compliant).toBe(false);
  });

  it('reports structure rules as skipped when the password is unknown', async () => {
    const report = await validate('pw.pdf');
    expect(report.skippedRules).toBe(11);
    expect(report.checkedRules).toBe(1); // ua-no-encryption-barrier only
    expect(report.violations).toEqual([]); // skipped ≠ failed
    expect(report.compliant).toBeNull();
    expect(report.notes.join(' ')).toMatch(/could not be decrypted/);
  });

  it('validates fully when the correct password is supplied', async () => {
    const report = await validate('pw.pdf', 'secret');
    expect(report.skippedRules).toBeUndefined();
    expect(report.checkedRules).toBe(12);
    expect(report.violations).toEqual([]);
  });

  it('rejects a wrong password with a structured error', async () => {
    await expect(validate('pw.pdf', 'wrong')).rejects.toMatchObject({
      code: 'WRONG_PASSWORD',
    });
  });

  it('produces a structurally valid plaintext rebuild (strict validators)', async () => {
    // pdf-lib is lenient about xref gaps, but veraPDF/qpdf are not: the
    // decrypted ObjStm must be expanded into plain objects so every object
    // is reachable from the rebuilt xref (found via veraPDF, v0.6.3).
    const { decryptDocumentBytes } = await import('../../src/services/decrypt-document.js');
    const { readFile } = await import('node:fs/promises');
    const bytes = new Uint8Array(await readFile(join(dir, 'pw.pdf')));
    const plain = await decryptDocumentBytes(bytes, 'secret');
    expect(plain).not.toBeNull();
    const out = join(dir, 'pw-decrypted.pdf');
    await writeFile(out, plain as Uint8Array);
    // qpdf --check exits non-zero on syntax/xref errors
    expect(() => execFileSync('qpdf', ['--check', out], { stdio: 'pipe' })).not.toThrow();
  });
});
