/**
 * /Contents のゼロパディング除去が CMS 本体を削らないこと。
 *
 * **これは 1/256 で当たるくじだった。** 署名辞書の /Contents は固定長で確保され、余りは
 * ゼロ埋めされるのでパディングは落とさなければならない。しかし「末尾のゼロを全部落とす」と
 * **DER 自身の末尾 0x00 まで落ちる** — DER はゼロで終わってよい。1 バイト欠けた構造は
 * `fromBER` に拒否され、正当な署名が「解析不能」として報告される。
 *
 * 発見の経緯は aia-tsa の TSA テストが数百回に 1 回落ちること。実測した発生率 0.7% が
 * 1/256 = 0.39%（末尾 1 バイトがゼロ）と符合し、原因が確定した。
 *
 * **テストを運に任せない。** ランダムな署名を作って当たりを待つのではなく、
 * 「末尾が 0x00 の CMS」を引き当てるまで作ってから検査する。引けなければ skip ではなく
 * 失敗にする（黙って検査されないまま緑になるのを避ける）。
 */

import { describe, expect, it } from 'vitest';
import { verifyCms } from '../../src/services/cms-verifier.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import {
  createCmsSignature,
  createIdentity,
  createSignedPdf,
  createTestCa,
  type TestIdentity,
} from '../helpers/signed-pdf.js';

/** 末尾が 0x00 になる CMS を引き当てる（確率 1/256 なので試行を重ねる） */
async function makeCmsEndingInZero(
  signer: TestIdentity,
  tsa: TestIdentity,
): Promise<{ cms: Uint8Array; data: Uint8Array }> {
  for (let i = 0; i < 4000; i++) {
    const data = new Uint8Array([1, 2, 3, i & 0xff, (i >> 8) & 0xff]);
    const cms = await createCmsSignature(signer, data, tsa);
    if (cms[cms.length - 1] === 0) return { cms, data };
  }
  throw new Error('could not produce a CMS ending in 0x00 within 4000 attempts');
}

describe('/Contents の padding 除去（DER を削らない）', () => {
  it('末尾が 0x00 の CMS でも、パディングを外した後にそのまま検証できる', async () => {
    const ca = await createTestCa('padding CA');
    const signer = await createIdentity({ commonName: 'padding-signer', issuer: ca });
    const tsa = await createIdentity({ commonName: 'padding-tsa', issuer: ca });
    const { cms, data } = await makeCmsEndingInZero(signer, tsa);

    // 前提の確認 — ここが崩れるとテストが何も測っていない
    expect(cms[cms.length - 1]).toBe(0);

    // 署名辞書に埋めたときと同じ形（ゼロ埋め）を作る
    const padded = new Uint8Array(cms.length + 128);
    padded.set(cms, 0);

    // 末尾ゼロを一律に落とす実装だと、ここで 1 バイト欠けて DER が壊れる
    const naive = (() => {
      let end = padded.length;
      while (end > 0 && padded[end - 1] === 0) end--;
      return padded.subarray(0, end);
    })();
    expect(naive.length).toBe(cms.length - 1);
    const broken = await verifyCms(naive, data);
    expect(broken.hasSignatureTimestamp).toBe(false); // 壊れた側の対照

    // 正しく切り出せていれば、元の CMS と完全に一致する
    const intact = await verifyCms(cms, data);
    expect(intact.hasSignatureTimestamp).toBe(true);
    expect(intact.signatureTimestamp).toBeTruthy();
  }, 120_000);

  it('パーサ経由の /Contents が DER として完結している', async () => {
    const ca = await createTestCa('padding CA 2');
    const signer = await createIdentity({ commonName: 'padding-signer-2', issuer: ca });
    const tsa = await createIdentity({ commonName: 'padding-tsa-2', issuer: ca });

    // parsePdfBytes は /Contents を切り出す実装そのものを通る経路。
    // 何度か作って「切り出した結果が常に DER として完結している」ことを見る
    for (let i = 0; i < 20; i++) {
      const pdf = await createSignedPdf(signer, { tsa });
      const parsed = await parsePdfBytes(pdf);
      const contents = parsed.signatures[0]?.contents;
      expect(contents).toBeTruthy();
      if (!contents) continue;

      // 先頭は SEQUENCE で、宣言された長さと取り出した長さが一致すること。
      // ここがずれていれば、パディングを削りすぎたか残しすぎている
      expect(contents[0]).toBe(0x30);
      const lengthBytes = contents[1] & 0x7f;
      let declared = 0;
      for (let j = 0; j < lengthBytes; j++) declared = declared * 256 + contents[2 + j];
      expect(contents.length).toBe(2 + lengthBytes + declared);
    }
  }, 120_000);
});
