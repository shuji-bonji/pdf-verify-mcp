/**
 * detect_pades_level / identify_conformance tests.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { PadesLevel } from '../../src/constants.js';
import { identifyConformance } from '../../src/services/conformance.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { detectPadesLevels } from '../../src/services/verification-service.js';
import { formatPadesReports } from '../../src/utils/formatter.js';
import { createSignedPdf, createTestIdentity, type TestIdentity } from '../helpers/signed-pdf.js';

let identity: TestIdentity;

beforeAll(async () => {
  identity = await createTestIdentity();
});

describe('detectPadesLevels', () => {
  it('CAdES signature without timestamp is PAdES B-B', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    const reports = await detectPadesLevels(parsed);

    expect(reports).toHaveLength(1);
    expect(reports[0].isPades).toBe(true);
    expect(reports[0].level).toBe(PadesLevel.B_B);
    expect(reports[0].evidence.hasSignatureTimestamp).toBe(false);
    expect(reports[0].evidence.hasDss).toBe(false);
  });

  it('adbe.pkcs7.detached is reported as non-PAdES', async () => {
    const pdf = await createSignedPdf(identity, { subFilter: 'adbe.pkcs7.detached' });
    const parsed = await parsePdfBytes(pdf);
    const reports = await detectPadesLevels(parsed);

    expect(reports).toHaveLength(1);
    expect(reports[0].isPades).toBe(false);
    expect(reports[0].level).toBeNull();
  });

  // --- V-F3 / Issue #9: T3（規範なし）であることを出力自体が持つ ---
  //
  // level だけを抜き出して「PAdES B-T 準拠」と書かれるのを防ぐのが目的。
  // `if` の中に expect を置かない — 消えたら落ちる形にしておく。
  it('reports T3 as the normative basis, on every signature', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    const reports = await detectPadesLevels(parsed);

    expect(reports.length).toBeGreaterThan(0);
    for (const r of reports) {
      expect(r.normativeBasis).toBe('T3');
    }
  });

  it('states in the notes that the level is an observation, not conformance', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    const reports = await detectPadesLevels(parsed);
    const notes = reports[0].notes.join(' ');

    // 「構造が一致する」であって「検出した」ではない
    expect(notes).toContain('The structure matches PAdES');
    expect(notes).toContain('not a conformance verdict');
    // 断定形（旧文言）に戻っていないこと
    expect(notes).not.toContain('Detected level:');
  });

  it('carries the caveat into the markdown, above the levels', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    const md = formatPadesReports(await detectPadesLevels(parsed));

    expect(md).toContain('Observation, not a conformance verdict');
    expect(md).toContain('Normative basis: **T3**');
    expect(md).toContain('structure matches');
    // 見出しより後ろに注記が埋もれていないか（level 行より前に出ること）
    expect(md.indexOf('Observation, not a conformance verdict')).toBeLessThan(
      md.indexOf('structure matches'),
    );
  });

  it('says nothing about a normative basis when there are no signatures', async () => {
    // 署名ゼロの経路では注記ブロックごと出ない（言うべき対象が無いのに免責だけ出さない）
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const parsed = await parsePdfBytes(await doc.save());
    const md = formatPadesReports(await detectPadesLevels(parsed));

    expect(md).toContain('No (non-timestamp) signatures found');
    expect(md).not.toContain('Normative basis');
  });
});

describe('identifyConformance', () => {
  it('detects declared PDF/A and PDF/UA in XMP', async () => {
    const pdf = await createSignedPdf(identity, {
      xmp: { pdfaPart: '2', pdfaConformance: 'B', pdfuaPart: '1' },
    });
    const parsed = await parsePdfBytes(pdf);
    const report = identifyConformance(parsed);

    expect(report.hasXmp).toBe(true);
    expect(report.pdfA).toEqual({ part: '2', conformance: 'B' });
    expect(report.pdfUa).toEqual({ part: '1' });
    expect(report.pdfVersion).toBe('1.7');
  });

  it('reports absence of declarations', async () => {
    const pdf = await createSignedPdf(identity);
    const parsed = await parsePdfBytes(pdf);
    const report = identifyConformance(parsed);

    expect(report.pdfA).toBeNull();
    expect(report.pdfUa).toBeNull();
    expect(report.notes.join(' ')).toContain('identifies declared conformance only');
  });
});
