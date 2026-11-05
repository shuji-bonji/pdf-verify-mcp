/**
 * リビジョン差分でオブジェクトの種類を読む（verify-integrity。pdf-verify-mcp#33・F-24）。
 *
 * 0.34.0 までの `peekObject` はオブジェクトの先頭から 4,096 バイトしか見ず、
 * `/Contents` の 16 進文字列が `/Type` より前にあると `/Type` まで届かなかった。
 * 試用の検体（contract-like-signed.pdf）では署名の辞書の `/Type` が 14,901 バイト目、
 * 文書タイムスタンプの辞書の `/Type` が 7,803 バイト目にあった。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { analyzeIntegrity } from '../../src/services/verification-service.js';
import type { RevisionObjectChange } from '../../src/types.js';
import {
  appendObjectRevision,
  createSignedPdf,
  createTestIdentity,
  type TestIdentity,
} from '../helpers/signed-pdf.js';

let identity: TestIdentity;
let plain: Uint8Array;

/** 10,000 文字の 16 進文字列（4,096 バイトの窓を確実に越える） */
const LONG_HEX = `<${'0'.repeat(10_000)}>`;
const BYTE_RANGE = '/ByteRange [0 100 200 300]';

beforeAll(async () => {
  identity = await createTestIdentity();
  plain = await createSignedPdf(identity);
});

async function changeOf(pdf: Uint8Array, body: string): Promise<RevisionObjectChange | undefined> {
  const appended = appendObjectRevision(pdf, { objects: [{ objectNumber: 8, body }] });
  const report = await analyzeIntegrity(await parsePdfBytes(appended));
  return report.revisions?.at(-1)?.changes?.find((c) => c.objectNumber === 8);
}

describe('SPEC-VERIFY-VERIFY-INTEGRITY-001 リビジョン差分は、キーの順序と文字列の長さにかかわらず辞書の /Type を読む', () => {
  it('SPEC-VERIFY-VERIFY-INTEGRITY-001 Contents の後ろに Type がある署名の辞書', async () => {
    const change = await changeOf(
      plain,
      `<< /Contents ${LONG_HEX} /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached ${BYTE_RANGE} >>`,
    );
    expect(change).toMatchObject({
      type: 'Sig',
      role: 'signature dictionary',
      changeClass: 'signature',
    });
  });

  it('SPEC-VERIFY-VERIFY-INTEGRITY-001 Contents の後ろに Type がある文書タイムスタンプの辞書', async () => {
    const change = await changeOf(
      plain,
      `<< /Contents ${LONG_HEX} /Type /DocTimeStamp /Filter /Adobe.PPKLite /SubFilter /ETSI.RFC3161 ${BYTE_RANGE} >>`,
    );
    expect(change).toMatchObject({
      type: 'DocTimeStamp',
      role: 'document timestamp',
      changeClass: 'signature',
    });
  });

  it('SPEC-VERIFY-VERIFY-INTEGRITY-001 P=2 の文書に足した署名は許された変更になる', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 2 });
    const appended = appendObjectRevision(certified, {
      objects: [
        {
          objectNumber: 8,
          body: `<< /Contents ${LONG_HEX} /Type /Sig /Filter /Adobe.PPKLite ${BYTE_RANGE} >>`,
        },
      ],
    });
    const report = await analyzeIntegrity(await parsePdfBytes(appended));
    expect(report.certification?.permission).toBe(2);
    expect(report.certification?.violationAssessment).toBe('permitted');
  });

  it('SPEC-VERIFY-VERIFY-INTEGRITY-001 Contents の後ろに Type があってもリテラル文字列の括弧で迷わない', async () => {
    // リテラル文字列の中の `>>` や `/Type` は辞書の終わりでもキーでもない
    const change = await changeOf(
      plain,
      `<< /Contents ${LONG_HEX} /Reason (a >> b /Type /Annot \\) c) /Type /Sig /Filter /Adobe.PPKLite ${BYTE_RANGE} >>`,
    );
    expect(change?.type).toBe('Sig');
  });
});

describe('SPEC-VERIFY-VERIFY-INTEGRITY-002 /Type の無い署名の辞書を、Table 255 の必須の項目で見分ける', () => {
  it('SPEC-VERIFY-VERIFY-INTEGRITY-002 Type の無い署名の辞書', async () => {
    const change = await changeOf(
      plain,
      `<< /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached ${BYTE_RANGE} /Contents ${LONG_HEX} >>`,
    );
    expect(change).toMatchObject({
      type: null,
      role: 'signature dictionary',
      changeClass: 'signature',
    });
  });

  it('SPEC-VERIFY-VERIFY-INTEGRITY-002 ByteRange の無い untyped の辞書は署名と見なさない', async () => {
    const change = await changeOf(plain, `<< /Filter /Adobe.PPKLite /Contents <00ff> >>`);
    expect(change?.changeClass).toBe('unknown');
  });
});
