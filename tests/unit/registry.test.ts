/**
 * 外部に出るツールの仕様（external spec）のスナップショット。
 *
 * この検査が無かったあいだに何が起きたか（2026-08-27 の実測）:
 * zod 3 の JSON Schema 変換は素の ZodObject にも `additionalProperties: false` を
 * 付けていたため、`.strict()` を 1 つも書いていないのに、7 ツールとも
 * `tools/list` の `inputSchema` に `false` が入っていた。zod 4 は付けない。
 * つまり **zod を上げるだけで `tools/list` から `additionalProperties: false` が消え、
 * クライアントは「宣言に無いキーも渡してよい」と読む**。
 * 型検査もテストも通ったままである。
 * 同じ形の無音の変化は SDK v2 移行でも起こりうる（移行ガイドは zod 3.x で
 * 「登録時の無音失敗」、zod 4.0–4.1 で「description が削除される」と書いている）。
 *
 * そこで、`tools/list` の実応答を次の 5 項目で固定する:
 *   1. ツール数
 *   2. 各ツールの description（消えていないこと）
 *   3. inputSchema の受け付ける引数
 *   4. inputSchema.additionalProperties —— `.strict()` が効いているかはここにしか出ない
 *   5. inputSchema.required
 *
 * 定義表ではなくプロトコル越しに測る。スキーマは zod から生成されるので、
 * ソースを読む検査は「その検査が守るはずの変更」と一緒に書き換わってしまう。
 * クライアントが実際に受け取る応答が契約である。
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';

/** ツール名 -> 必須フィールド。いま公開しているとおり。 */
const EXPECTED_REQUIRED: Record<string, string[]> = {
  verify_signatures: ['file_path'],
  verify_integrity: ['file_path'],
  detect_pades_level: ['file_path'],
  identify_conformance: ['file_path'],
  validate_conformance: ['file_path'],
  validate_clauses: ['file_path'],
  evaluate_policy: ['file_path'],
};

/** ツール名 -> 受け付ける引数の全部。黙って落ちた引数を捕まえる。 */
const EXPECTED_PROPERTIES: Record<string, string[]> = {
  verify_signatures: [
    'file_path',
    'response_format',
    'trust_anchors',
    'check_revocation',
    'password',
  ],
  verify_integrity: ['file_path', 'response_format'],
  detect_pades_level: ['file_path', 'response_format'],
  identify_conformance: ['file_path', 'response_format'],
  validate_conformance: ['file_path', 'response_format', 'flavour', 'engine', 'password'],
  validate_clauses: ['file_path', 'response_format', 'domains', 'given'],
  evaluate_policy: [
    'file_path',
    'response_format',
    'profile',
    'trust_anchors',
    'check_revocation',
    'password',
  ],
};

/** ネットワークに出る可能性があるのは verify_signatures だけ（check_revocation: 'online'）。 */
const OPEN_WORLD: Record<string, boolean> = {
  verify_signatures: true,
  verify_integrity: false,
  detect_pades_level: false,
  identify_conformance: false,
  validate_conformance: false,
  validate_clauses: false,
  evaluate_policy: false,
};

interface ListedTool {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
  inputSchema: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: unknown;
  };
}

/** InMemoryTransport で繋いだクライアントを 1 つ返す。 */
async function connect(): Promise<Client> {
  const server = buildServer();
  const client = new Client({ name: 'registry-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

let listed: ListedTool[];

beforeAll(async () => {
  const client = await connect();
  const res = await client.listTools();
  listed = res.tools as ListedTool[];
});

describe('tool registry (external spec)', () => {
  // 1. ツール数
  it('7 つのツールをちょうど公開する', () => {
    expect(listed.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_REQUIRED).sort());
  });

  // 2. description
  it('どのツールも description を持つ', () => {
    // zod 4.0–4.1 のフォールバックは description を落とす。落ちても型検査は通る。
    for (const tool of listed) {
      expect(tool.description, tool.name).toBeTruthy();
      expect((tool.description ?? '').length, tool.name).toBeGreaterThan(200);
    }
  });

  // 3. 受け付ける引数
  it.each(Object.entries(EXPECTED_PROPERTIES))('%s は引数の一覧を保つ', (name, props) => {
    const tool = listed.find((t) => t.name === name);
    expect(tool).toBeDefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([...props].sort());
  });

  it('どのツールもオブジェクトを取る', () => {
    for (const tool of listed) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
    }
  });

  // 4. additionalProperties
  it('どのツールも additionalProperties: false を返す', () => {
    // `.strict()` が効いているかはここにしか出ない。
    // 「false」と「そもそも無い」を区別するため、値の一致ではなくキーの有無から見る。
    for (const tool of listed) {
      expect(
        Object.hasOwn(tool.inputSchema, 'additionalProperties'),
        `${tool.name}: inputSchema に additionalProperties が無い（.strict() が外れている）`,
      ).toBe(true);
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  // 5. required
  it.each(Object.entries(EXPECTED_REQUIRED))('%s は必須フィールドを保つ', (name, required) => {
    const tool = listed.find((t) => t.name === name);
    expect(tool).toBeDefined();
    expect((tool?.inputSchema.required ?? []).sort()).toEqual([...required].sort());
  });

  it('注釈は読み取り専用で、ネットワークに出るのは verify_signatures だけ', () => {
    for (const tool of listed) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.openWorldHint, tool.name).toBe(OPEN_WORLD[tool.name]);
    }
  });
});

describe('入力検証の境界', () => {
  it('スキーマに無い引数を渡すと拒否する（tools/list の記述と動作が一致していること）', async () => {
    // `.strict()` を入れる前は、tools/list は additionalProperties: false と書いて
    // いたのに、zod 3 の既定が strip だったため、宣言に無い引数は受け取ったうえで
    // 黙って捨てられ、ツールは成功を返していた。
    const client = await connect();

    const res = await client.callTool({
      name: 'verify_integrity',
      arguments: { file_path: '/nonexistent.pdf', no_such_arg: 'x' },
    });

    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(
      /Unrecognized key|Invalid arguments/,
    );
  });

  it('必須フィールドが無ければ SDK が前段で拒否する', async () => {
    const client = await connect();

    const res = await client.callTool({ name: 'verify_integrity', arguments: {} });

    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain('Invalid arguments');
  });

  it('知らないツール名は JSON-RPC エラーとして返り、サーバは動き続ける', async () => {
    // SDK v2 で失敗の届け先が変わった（2026-08-27 に生の JSON-RPC で実測）。
    //   v1: ツール結果 { isError: true, content: [{ text: 'MCP error -32602: Tool ... not found' }] }
    //   v2: JSON-RPC の error（code -32602）。ツール結果は返らない
    // 入力検証の失敗は v1 / v2 とも isError: true のまま（上の 2 つのテスト）。
    // 移ったのは「ツール名が無い」場合だけである。
    const client = await connect();

    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(
      /no_such_tool/,
    );

    // 同じクライアントで次の呼び出しが通ることを見る（サーバが動き続けている）。
    const ok = await client.listTools();
    expect(ok.tools.length).toBe(Object.keys(EXPECTED_REQUIRED).length);
  });
});
