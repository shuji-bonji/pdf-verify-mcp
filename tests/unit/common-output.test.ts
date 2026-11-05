/**
 * 成功の応答の共通項目（common-output。pdf-verify-mcp#34・F-17・F-29）。
 *
 * ツールは McpServer に登録した実物を InMemoryTransport 越しに呼び、本文を見る。
 * 受け側が読むのは本文なので、関数の戻り値ではなく本文を契約として固定する。
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import {
  appendObjectRevision,
  createSignedPdf,
  createTestIdentity,
} from '../helpers/signed-pdf.js';

const TOOLS = [
  'verify_signatures',
  'verify_integrity',
  'detect_pades_level',
  'identify_conformance',
  'validate_conformance',
  'validate_clauses',
  'evaluate_policy',
] as const;

let client: Client;
const files = { signed: '', withDts: '' };

beforeAll(async () => {
  const server = buildServer();
  client = new Client({ name: 'common-output-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const dir = await mkdtemp(join(tmpdir(), 'pdf-verify-output-'));
  const signed = await createSignedPdf(await createTestIdentity());
  // 署名 1 本の後に、文書タイムスタンプの辞書を増分更新で 1 本足す。
  // /Contents は検証できない中身だが、数える対象には入る（ByteRange と Contents を持つ）
  const withDts = appendObjectRevision(signed, {
    objects: [
      {
        objectNumber: 8,
        // 末尾の 0 は詰め物として切られる（trimSignatureContents）ので、0 でない値で埋める
        body: `<< /Type /DocTimeStamp /Filter /Adobe.PPKLite /SubFilter /ETSI.RFC3161 /ByteRange [0 10 20 30] /Contents <${'ab'.repeat(64)}> >>`,
      },
    ],
  });
  files.signed = join(dir, 'signed.pdf');
  files.withDts = join(dir, 'signed-with-dts.pdf');
  await writeFile(files.signed, signed);
  await writeFile(files.withDts, withDts);
});

async function call(tool: string, args: Record<string, unknown>): Promise<string> {
  const res = (await client.callTool({ name: tool, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  expect(res.isError ?? false).toBe(false);
  return res.content[0].text;
}

async function callJson(tool: string, filePath: string): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = { file_path: filePath, response_format: 'json' };
  if (tool === 'validate_conformance') args.engine = 'native';
  return JSON.parse(await call(tool, args)) as Record<string, unknown>;
}

describe('SPEC-VERIFY-COMMON-OUTPUT-001 成功の応答は受け取った file_path を返す', () => {
  for (const tool of TOOLS) {
    it(`SPEC-VERIFY-COMMON-OUTPUT-001 7 ツールの JSON が file_path を返す（${tool}）`, async () => {
      const body = await callJson(tool, files.signed);
      expect(Object.keys(body)[0]).toBe('file_path');
      expect(body.file_path).toBe(files.signed);
    });
  }

  it('SPEC-VERIFY-COMMON-OUTPUT-001 markdown も file_path を書く', async () => {
    const text = await call('evaluate_policy', {
      file_path: files.signed,
      response_format: 'markdown',
    });
    expect(text).toContain(`File: ${files.signed}`);
    // 見出しは先頭のまま
    expect(text.startsWith('# ')).toBe(true);
  });
});

describe('SPEC-VERIFY-COMMON-OUTPUT-002 signatureCount は文書タイムスタンプを除いた署名の数にする', () => {
  it('SPEC-VERIFY-COMMON-OUTPUT-002 署名 1 本と文書タイムスタンプ 1 本の文書（verify_integrity）', async () => {
    const body = await callJson('verify_integrity', files.withDts);
    expect(body.signatureCount).toBe(1);
    expect(body.documentTimestampCount).toBe(1);
  });

  it('SPEC-VERIFY-COMMON-OUTPUT-002 署名 1 本と文書タイムスタンプ 1 本の文書（evaluate_policy）', async () => {
    const body = await callJson('evaluate_policy', files.withDts);
    const facts = body.facts as Record<string, unknown>;
    expect(facts.signatureCount).toBe(1);
    expect(facts.documentTimestampCount).toBe(1);
    expect(facts.signatures).toHaveLength(2);
  });

  it('SPEC-VERIFY-COMMON-OUTPUT-002 文書タイムスタンプの無い文書', async () => {
    const body = await callJson('verify_integrity', files.signed);
    expect(body.signatureCount).toBe(1);
    expect(body.documentTimestampCount).toBe(0);
  });
});
