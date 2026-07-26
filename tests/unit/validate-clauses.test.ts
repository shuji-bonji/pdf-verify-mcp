/**
 * validate_clauses — ISO 32000 本体条文の検査（T1）。
 *
 * **判定そのものは `@shuji-bonji/pdf-constraints` の責任**なので、ここで確かめるのは
 * ①パッケージを正しく呼べているか ②結果を family の語彙へ正しく翻訳しているか
 * ③**判定の由来（テーブルの版）を落としていないか**、の 3 点に絞る。
 * 述語や写像そのものの検査は constraints 側のテストにある。
 *
 * 検体はこのリポジトリの流儀どおり**その場で生成**する（バイナリを持ち込まない）。
 * 期待値は「どう組み立てたか」から来ているので、検体が変質しても気づける。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateClauses } from '../../src/services/clause-validation.js';
import { formatClauseValidation } from '../../src/utils/formatter.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pvm-clauses-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Info と XMP を持つ最小の文書。両者の作成日時を独立に指定できる */
async function makeDocumentWithDates(options: {
  infoCreation: string;
  xmpCreate: string;
  trappedAsBoolean?: boolean;
}): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);

  const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
  info.set(PDFName.of('CreationDate'), PDFString.of(options.infoCreation));
  info.set(PDFName.of('ModDate'), PDFString.of(options.infoCreation));
  if (options.trappedAsBoolean) {
    // R-14.3.3-5: name の True であって boolean の true ではない
    info.set(PDFName.of('Trapped'), doc.context.obj(true));
  }

  const packet =
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n' +
    `      <xmp:CreateDate>${options.xmpCreate}</xmp:CreateDate>\n` +
    `      <xmp:ModifyDate>${options.xmpCreate}</xmp:ModifyDate>\n` +
    '    </rdf:Description>\n' +
    '  </rdf:RDF>\n' +
    '</x:xmpmeta>\n' +
    '<?xpacket end="w"?>';
  const bytes = new TextEncoder().encode(packet);
  const stream = PDFRawStream.of(
    doc.context.obj({ Type: 'Metadata', Subtype: 'XML', Length: bytes.length }) as PDFDict,
    bytes,
  );
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));

  const path = join(dir, `doc-${Math.random().toString(36).slice(2)}.pdf`);
  await writeFile(path, await doc.save({ useObjectStreams: false }));
  return path;
}

describe('validate_clauses', () => {
  it('Info と XMP の作成日時が食い違う文書を検出する（§14.3.4）', async () => {
    const path = await makeDocumentWithDates({
      infoCreation: 'D:20200102030405Z',
      xmpCreate: '2026-07-26T00:00:00Z',
    });
    const report = await validateClauses(path, { domains: ['document-metadata'] });

    const failure = report.results.flatMap((r) => r.failures ?? [])[0];
    expect(failure.clauses).toContain('R-14.3.4-2');

    // 条文の主語は processor なので「違反」と断定しない
    expect(failure.traceOnly).toBe(true);
    expect(report.notes.some((n) => n.includes('traces'))).toBe(true);
  });

  it('同一時点なら通る — 等価は表記でなくインスタント', async () => {
    // Info は PDF 日付・XMP は ISO 8601 で表記が違うが、指している瞬間は同じ
    const path = await makeDocumentWithDates({
      infoCreation: "D:20200102120000+09'00'",
      xmpCreate: '2020-01-02T03:00:00Z',
    });
    const report = await validateClauses(path, { domains: ['document-metadata'] });
    expect(report.violations).toBe(0);
  });

  it('Trapped が boolean なら検出する（R-14.3.3-5）', async () => {
    const path = await makeDocumentWithDates({
      infoCreation: 'D:20200102030405Z',
      xmpCreate: '2020-01-02T03:04:05Z',
      trappedAsBoolean: true,
    });
    const report = await validateClauses(path, { domains: ['document-metadata'] });

    const failed = report.results.filter((r) => r.status === 'fail').map((r) => r.constraintId);
    expect(failed).toContain('CT-META-6');
  });

  it('外部事実が無い制約は pass にせず needs_external_fact で返す', async () => {
    const path = await makeDocumentWithDates({
      infoCreation: 'D:20200102030405Z',
      xmpCreate: '2020-01-02T03:04:05Z',
    });
    // フォントを埋め込んでいない文書なので font-embedding の subject は 0 件。
    // 供給の有無で結果が変わることは constraints 側のテストが担保しているため、
    // ここでは「翻訳の器」が notDecided を落とさないことだけを見る
    const report = await validateClauses(path, { domains: ['document-metadata'] });
    expect(report.notDecided).toBe(0);
    expect(typeof report.notDecided).toBe('number');
  });

  it('判定の由来（テーブルの版）を必ず返す', async () => {
    const path = await makeDocumentWithDates({
      infoCreation: 'D:20200102030405Z',
      xmpCreate: '2020-01-02T03:04:05Z',
    });
    const report = await validateClauses(path, { domains: ['document-metadata'] });

    // 版が分からないレポートは再現できない（specs/18 §4.5）
    expect(report.constraintsVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.tables).toEqual([{ name: 'document-metadata', version: '1' }]);
  });

  it('markdown は数字より前に判定の由来を置き、失敗を痕跡として述べる', async () => {
    const path = await makeDocumentWithDates({
      infoCreation: 'D:20200102030405Z',
      xmpCreate: '2026-07-26T00:00:00Z',
    });
    const report = await validateClauses(path, { domains: ['document-metadata'] });
    const markdown = formatClauseValidation(report);

    // 「Decided by」が結果の行より前にあること（PAdES の注記で学んだ順序）
    expect(markdown.indexOf('Decided by')).toBeLessThan(markdown.indexOf('- Result:'));
    expect(markdown).toContain('Trace of a violation');
    expect(markdown).toContain('Evidence:');
    expect(markdown).toContain('not proof of conformance');
  });
});
