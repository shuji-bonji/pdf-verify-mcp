/**
 * 鍵を導けない暗号化文書の扱い（pdf-verify-mcp#31・F-02・F-03）。
 *
 * 0.34.0 は、空の利用者パスワードで鍵を導けない文書でオブジェクトを 1 つも読めていないのに、
 * 読めなかった XMP・OutputIntent を違反に、探せなかった署名を「無い」に数えていた。
 * 検体は qpdf で `--encrypt secret owner 256` を掛ける（qpdf が無ければ飛ばす。CI は入れている）。
 * ツールは McpServer に登録した実物を InMemoryTransport 越しに呼び、本文を見る。
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import { createSignedPdf, createTestIdentity } from '../helpers/signed-pdf.js';

function qpdfAvailable(): boolean {
  try {
    execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const describeQpdf = qpdfAvailable() ? describe : describe.skip;

let client: Client;
const files = { locked: '', plainUnsigned: '' };

interface Body {
  [key: string]: unknown;
}

async function call(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; body: Body }> {
  const res = (await client.callTool({ name: tool, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = res.content[0].text;
  let body: Body = {};
  try {
    body = JSON.parse(text) as Body;
  } catch {
    // markdown
  }
  return { isError: res.isError === true, text, body };
}

beforeAll(async () => {
  if (!qpdfAvailable()) return;
  const server = buildServer();
  client = new Client({ name: 'unauthenticated-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const dir = await mkdtemp(join(tmpdir(), 'pdf-verify-locked-'));
  await writeFile(join(dir, 'signed.pdf'), await createSignedPdf(await createTestIdentity()));
  execFileSync('qpdf', ['--encrypt', 'secret', 'owner', '256', '--', 'signed.pdf', 'locked.pdf'], {
    cwd: dir,
  });
  files.locked = join(dir, 'locked.pdf');
  const doc = await PDFDocument.create();
  doc.addPage();
  files.plainUnsigned = join(dir, 'plain-unsigned.pdf');
  await writeFile(files.plainUnsigned, await doc.save());
});

describeQpdf(
  'SPEC-VERIFY-VALIDATE-CONFORMANCE-016 鍵を導けない暗号化文書の PDF/A 判定は、エンジンにかかわらず ENCRYPTED_PDF にする',
  () => {
    it('SPEC-VERIFY-VALIDATE-CONFORMANCE-016 native エンジンでも ENCRYPTED_PDF', async () => {
      const { isError, body } = await call('validate_conformance', {
        file_path: files.locked,
        flavour: 'pdfa-2b',
        engine: 'native',
      });
      expect(isError).toBe(true);
      expect(body.code).toBe('ENCRYPTED_PDF');
      expect(body.retryable).toBe(true);
      const actions = body.next_actions as { action: string; example?: Record<string, unknown> }[];
      expect(actions[0].action).toBe('validate_conformance');
      expect(actions[0].example).toMatchObject({ file_path: files.locked });
      expect(actions[0].example).toHaveProperty('password');
    });

    it('SPEC-VERIFY-VALIDATE-CONFORMANCE-016 flavour を省いても ENCRYPTED_PDF', async () => {
      const { isError, body } = await call('validate_conformance', {
        file_path: files.locked,
        engine: 'native',
      });
      expect(isError).toBe(true);
      expect(body.code).toBe('ENCRYPTED_PDF');
    });

    it('SPEC-VERIFY-VALIDATE-CONFORMANCE-016 password を渡せば判定する', async () => {
      const { isError, body } = await call('validate_conformance', {
        file_path: files.locked,
        flavour: 'pdfa-2b',
        engine: 'native',
        password: 'secret',
        response_format: 'json',
      });
      expect(isError).toBe(false);
      expect((body.scope as Body).authenticated).toBe(true);
      const ids = (body.violations as { ruleId: string }[]).map((v) => v.ruleId);
      expect(ids).toContain('no-encryption');
    });
  },
);

describeQpdf(
  'SPEC-VERIFY-VERIFY-SIGNATURES-001 鍵を導けない文書では、署名を探せなかったことを null と note で示す',
  () => {
    it('SPEC-VERIFY-VERIFY-SIGNATURES-001 利用者パスワード付きの文書', async () => {
      const { isError, body } = await call('verify_signatures', {
        file_path: files.locked,
        response_format: 'json',
      });
      expect(isError).toBe(false);
      expect(body.signatures).toBeNull();
      expect(typeof body.note).toBe('string');
      expect((body.note as string).length).toBeGreaterThan(0);
    });

    it('SPEC-VERIFY-VERIFY-SIGNATURES-001 markdown で No signatures と書かない', async () => {
      const { text } = await call('verify_signatures', {
        file_path: files.locked,
        response_format: 'markdown',
      });
      expect(text).not.toMatch(/No signature/i);
      expect(text).toMatch(/could not be looked for/);
    });

    it('SPEC-VERIFY-VERIFY-SIGNATURES-001 暗号化されていない無署名の文書は空の一覧', async () => {
      const { body } = await call('verify_signatures', {
        file_path: files.plainUnsigned,
        response_format: 'json',
      });
      expect(body.signatures).toEqual([]);
      expect(body).not.toHaveProperty('note');
    });
  },
);

describeQpdf(
  'SPEC-VERIFY-EVALUATE-POLICY-001 鍵を導けない文書では、署名を探せなかったことを null と note で示す',
  () => {
    it('SPEC-VERIFY-EVALUATE-POLICY-001 利用者パスワード付きの文書', async () => {
      const { isError, body } = await call('evaluate_policy', {
        file_path: files.locked,
        profile: 'general',
        response_format: 'json',
      });
      expect(isError).toBe(false);
      const facts = body.facts as Body;
      expect(facts.signatures).toBeNull();
      expect(facts.signatureCount).toBeNull();
      expect(facts.documentTimestampCount).toBeNull();
      expect(typeof facts.note).toBe('string');
    });

    it('SPEC-VERIFY-EVALUATE-POLICY-001 password を渡せば数える', async () => {
      const { body } = await call('evaluate_policy', {
        file_path: files.locked,
        profile: 'general',
        password: 'secret',
        response_format: 'json',
      });
      const facts = body.facts as Body;
      expect(Number.isInteger(facts.signatureCount)).toBe(true);
      expect(facts).not.toHaveProperty('note');
    });
  },
);

describeQpdf(
  'SPEC-VERIFY-EVALUATE-POLICY-002 署名が無いという規則は、無いと観測できたときだけ発火させる',
  () => {
    const ruleIds = (body: Body) => (body.firedRules as { ruleId: string }[]).map((r) => r.ruleId);

    it('SPEC-VERIFY-EVALUATE-POLICY-002 探せなかった文書に No signatures を言わない', async () => {
      const { body } = await call('evaluate_policy', {
        file_path: files.locked,
        profile: 'general',
        response_format: 'json',
      });
      expect(ruleIds(body)).not.toContain('POL-CAUTION-UNSIGNED');
      expect(ruleIds(body)).toContain('POL-REVIEW-SIGNATURES-NOT-READ');
      expect(body.verdict).toBe('human_review_required');
    });

    it('SPEC-VERIFY-EVALUATE-POLICY-002 署名を要する profile でも同じ', async () => {
      const { body } = await call('evaluate_policy', {
        file_path: files.locked,
        profile: 'contract',
        response_format: 'json',
      });
      expect(ruleIds(body)).not.toContain('POL-REVIEW-UNSIGNED-REQUIRED');
      expect(ruleIds(body)).toContain('POL-REVIEW-SIGNATURES-NOT-READ');
    });

    it('SPEC-VERIFY-EVALUATE-POLICY-002 読めた無署名の文書は今までどおり', async () => {
      const { body } = await call('evaluate_policy', {
        file_path: files.plainUnsigned,
        profile: 'general',
        response_format: 'json',
      });
      expect(ruleIds(body)).toContain('POL-CAUTION-UNSIGNED');
      expect(ruleIds(body)).not.toContain('POL-REVIEW-SIGNATURES-NOT-READ');
    });
  },
);

describeQpdf('SPEC-VERIFY-COMMON-OUTPUT-003 鍵を導けない文書では、署名の数を null にする', () => {
  it('SPEC-VERIFY-COMMON-OUTPUT-003 verify_integrity の数', async () => {
    const { isError, body } = await call('verify_integrity', {
      file_path: files.locked,
      response_format: 'json',
    });
    expect(isError).toBe(false);
    expect(body.signatureCount).toBeNull();
    expect(body.documentTimestampCount).toBeNull();
  });
});
