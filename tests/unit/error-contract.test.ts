/**
 * エラー応答の契約（common-errors。pdf-verify-mcp#35・#32、pdf-agent-stack#48）。
 *
 * ツールは McpServer に登録した実物を InMemoryTransport 越しに呼び、ツール結果の本文
 * （`content[0].text` の JSON）を見る。受け側（pdf-trust Skill・pdf-agent-stack の S6）が
 * 読むのはこの本文なので、`PdfVerifyError` の中身ではなく本文を契約として固定する。
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import {
  handleStructuredError,
  RETRYABLE,
  type VerifyErrorCode,
} from '../../src/utils/error-handler.js';

const TOOLS = [
  'verify_signatures',
  'verify_integrity',
  'detect_pades_level',
  'identify_conformance',
  'validate_conformance',
  'validate_clauses',
  'evaluate_policy',
] as const;

/** 契約の最上位の項目（001）。0.33.x の移行の版の `message`・`suggestion` は 0.34.0 で外した */
const TOP_LEVEL = ['error', 'code', 'retryable', 'hint', 'detail'];

interface ErrorBody {
  error: unknown;
  code: string;
  retryable: unknown;
  hint?: string;
  detail?: { reason?: string };
}

let client: Client;
let dir: string;
const files = { missing: '', notPdf: '', empty: '', folder: '', noObjects: '', valid: '' };

beforeAll(async () => {
  const server = buildServer();
  client = new Client({ name: 'error-contract-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  dir = await mkdtemp(join(tmpdir(), 'pdf-verify-errors-'));
  files.missing = join(dir, 'no-such-file.pdf');
  files.notPdf = join(dir, 'not-a-pdf.pdf');
  files.empty = join(dir, 'empty.pdf');
  files.folder = dir;
  files.noObjects = join(dir, 'no-objects.pdf');
  files.valid = join(dir, 'valid.pdf');
  await writeFile(files.notPdf, 'This is a text file, not a PDF.\n');
  await writeFile(files.empty, '');
  // 相互参照表も `N G obj` も無い = 組み直す材料が 1 つも無い
  await writeFile(files.noObjects, Buffer.from('%PDF-1.7\n%%EOF\n', 'latin1'));
  const doc = await PDFDocument.create();
  doc.addPage();
  await writeFile(files.valid, await doc.save());
});

async function callError(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: ErrorBody }> {
  const res = (await client.callTool({ name: tool, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { isError: res.isError === true, body: JSON.parse(res.content[0].text) as ErrorBody };
}

function expectShape(body: ErrorBody): void {
  for (const key of Object.keys(body)) expect(TOP_LEVEL).toContain(key);
  expect(typeof body.error).toBe('string');
  expect(body.error).not.toBe('');
  expect(typeof body.code).toBe('string');
  expect(typeof body.retryable).toBe('boolean');
  if (body.hint !== undefined) expect(typeof body.hint).toBe('string');
}

describe('SPEC-VERIFY-COMMON-ERRORS-001 エラー応答の本文は family の平らな形にする', () => {
  it('SPEC-VERIFY-COMMON-ERRORS-001 存在しないパスのエラーが形どおり', async () => {
    const { isError, body } = await callError('identify_conformance', {
      file_path: files.missing,
      response_format: 'json',
    });
    expect(isError).toBe(true);
    expectShape(body);
  });

  it('SPEC-VERIFY-COMMON-ERRORS-001 故障のエラーも形どおり', () => {
    const body = handleStructuredError(new Error('boom')) as unknown as ErrorBody;
    expectShape(body);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.error).toBe('boom');
    expect(body.retryable).toBe(false);
  });

  it('SPEC-VERIFY-COMMON-ERRORS-001 移行の版の旧い名前を返さない', async () => {
    const bodies = [
      (await callError('identify_conformance', { file_path: files.missing })).body,
      (await callError('identify_conformance', { file_path: files.notPdf })).body,
      (await callError('identify_conformance', { file_path: 'relative/file.pdf' })).body,
      handleStructuredError(new Error('boom')) as unknown as ErrorBody,
    ];
    for (const body of bodies) {
      expect(body).not.toHaveProperty('message');
      expect(body).not.toHaveProperty('suggestion');
      expect(body.detail ?? {}).not.toHaveProperty('legacyCode');
    }
  });
});

describe('SPEC-VERIFY-COMMON-ERRORS-002 同じ状況には family の共通語彙の code を返す', () => {
  it('SPEC-VERIFY-COMMON-ERRORS-002 存在しないパスは DOC_NOT_FOUND', async () => {
    const { body } = await callError('identify_conformance', { file_path: files.missing });
    expect(body.code).toBe('DOC_NOT_FOUND');
  });

  it('SPEC-VERIFY-COMMON-ERRORS-002 相対パスは INVALID_ARGUMENT', async () => {
    const { body } = await callError('identify_conformance', { file_path: 'relative/file.pdf' });
    expect(body.code).toBe('INVALID_ARGUMENT');
    expect(body.detail?.reason).toBe('RELATIVE_PATH');
  });

  it('SPEC-VERIFY-COMMON-ERRORS-002 フォルダーは INVALID_ARGUMENT', async () => {
    const { body } = await callError('identify_conformance', { file_path: files.folder });
    expect(body.code).toBe('INVALID_ARGUMENT');
    expect(body.detail?.reason).toBe('NOT_A_FILE');
  });

  it('SPEC-VERIFY-COMMON-ERRORS-002 不正な flavour は INVALID_ARGUMENT', async () => {
    const { isError, body } = await callError('validate_conformance', {
      file_path: files.valid,
      flavour: 'pdfa-4b',
      engine: 'native',
    });
    expect(isError).toBe(true);
    expectShape(body);
    expect(body.code).toBe('INVALID_ARGUMENT');
    expect(body.detail?.reason).toBe('INVALID_FLAVOUR');
  });
});

describe('SPEC-VERIFY-COMMON-ERRORS-003 構造の条文に反して読めない文書は INVALID_PDF の所見として返す', () => {
  const FINDING = /finding about the file, not a failure of this server/;

  it('SPEC-VERIFY-COMMON-ERRORS-003 PDF でないファイルは INVALID_PDF', async () => {
    const { body } = await callError('identify_conformance', { file_path: files.notPdf });
    expectShape(body);
    expect(body.code).toBe('INVALID_PDF');
    expect(body.error).toContain('§7.5.2');
    expect(body.hint).toMatch(FINDING);
  });

  it('SPEC-VERIFY-COMMON-ERRORS-003 0 バイトのファイルは INVALID_PDF', async () => {
    const { body } = await callError('identify_conformance', { file_path: files.empty });
    expect(body.code).toBe('INVALID_PDF');
    expect(body.error).toContain('§7.5.2');
  });

  it('SPEC-VERIFY-COMMON-ERRORS-003 組み直す材料の無い文書は INVALID_PDF', async () => {
    const { body } = await callError('validate_clauses', { file_path: files.noObjects });
    expectShape(body);
    expect(body.code).toBe('INVALID_PDF');
    expect(body.hint).toMatch(FINDING);
  });
});

describe('SPEC-VERIFY-COMMON-ERRORS-004 7 ツールは同じパスの失敗に同じ code を返す', () => {
  it('SPEC-VERIFY-COMMON-ERRORS-004 validate_clauses も存在しないパスは DOC_NOT_FOUND', async () => {
    const { body } = await callError('validate_clauses', { file_path: files.missing });
    expect(body.code).toBe('DOC_NOT_FOUND');
  });

  it('SPEC-VERIFY-COMMON-ERRORS-004 validate_clauses も相対パスは INVALID_ARGUMENT', async () => {
    const { body } = await callError('validate_clauses', { file_path: 'relative/file.pdf' });
    expect(body.code).toBe('INVALID_ARGUMENT');
    expect(body.detail?.reason).toBe('RELATIVE_PATH');
  });

  for (const tool of TOOLS) {
    it(`SPEC-VERIFY-COMMON-ERRORS-004 7 ツールとも存在しないパスは DOC_NOT_FOUND（${tool}）`, async () => {
      const { isError, body } = await callError(tool, { file_path: files.missing });
      expect(isError).toBe(true);
      expectShape(body);
      expect(body.code).toBe('DOC_NOT_FOUND');
    });
  }
});

describe('SPEC-VERIFY-COMMON-ERRORS-005 retryable は code ごとに 1 つの値にする', () => {
  it('SPEC-VERIFY-COMMON-ERRORS-005 引数の誤りは再試行できる', async () => {
    const { body } = await callError('identify_conformance', { file_path: 'relative/file.pdf' });
    expect(body.retryable).toBe(true);
  });

  it('SPEC-VERIFY-COMMON-ERRORS-005 文書の所見は再試行できない', async () => {
    const { body } = await callError('identify_conformance', { file_path: files.notPdf });
    expect(body.retryable).toBe(false);
  });

  it('SPEC-VERIFY-COMMON-ERRORS-005 すべての code に値が決まっている', () => {
    const expected: Record<VerifyErrorCode, boolean> = {
      INVALID_ARGUMENT: true,
      ENCRYPTED_PDF: true,
      WRONG_PASSWORD: true,
      VERAPDF_NOT_FOUND: true,
      VERAPDF_NOT_AVAILABLE: true,
      DOC_NOT_FOUND: false,
      INVALID_PDF: false,
      FILE_TOO_LARGE: false,
      INVALID_BYTE_RANGE: false,
      VERAPDF_NO_RESULT: false,
      INTERNAL_ERROR: false,
    };
    expect(RETRYABLE).toEqual(expected);
  });
});
