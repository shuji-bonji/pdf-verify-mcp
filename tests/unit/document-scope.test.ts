/**
 * `DocumentScope` の申告を、止まり方 4 通りで固定する。
 *
 * 0.19.0 の基準（2,947 検体）では `XrefChainStop` の 5 値のうち 3 値しか踏まれて
 * いなかった。`cyclic` と `malformed` は 1 件も無い。ここで踏む。
 *
 * 検体の本文は `scripts/lib/xref-specimen-builder.mjs` —— ゴールデンの
 * `.golden/specimens/xref-*.pdf` と**同じ組み立て**を読む。テストと検体が別々の
 * 作り方をしていると、片方だけ狙いを外しても気づけない。
 *
 * 空振り検査の対は `complete`。ほかの 3 つが主張する値を、素の文書が**取らない**
 * ことを同じ表で確かめる。これが無いと「常に true を返す」実装でも緑になる。
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDocument, toReadingScope } from '@normativepdf/recover';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — 検体の組み立ては .mjs で、型宣言を持たない（tests は tsc の対象外）
import { specimens, toBytes } from '../../scripts/lib/xref-specimen-builder.mjs';
import { validateClauses } from '../../src/services/clause-validation.js';
import { identifyConformance } from '../../src/services/conformance.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { detectPadesLevels } from '../../src/services/verification-service.js';
import { PdfVerifyError } from '../../src/utils/error-handler.js';
import {
  formatPadesReports,
  formatReadingScope,
  formatSignatureReports,
} from '../../src/utils/formatter.js';

const open = async (name: keyof typeof specimens) =>
  (await openDocument(toBytes(specimens[name]()))).scope;

describe('DocumentScope — 相互参照チェーンの止まり方', () => {
  it('条文どおりの文書は、回復に入らず complete で終わる', async () => {
    const scope = await open('complete');
    expect(scope.chainStop.kind).toBe('complete');
    expect(scope.recovered).toBe(false);
    expect(scope.reconstructed).toBe(false);
    expect(scope.continuedPastStop).toBe(false);
    expect(scope.newestSectionUnreadable).toBe(false);
    expect(scope.objects).toBeGreaterThan(0);
  });

  it('`/Prev` が自分の節を指す文書は cyclic として止まる', async () => {
    const scope = await open('cyclic');
    expect(scope.chainStop.kind).toBe('cyclic');
    expect(scope.recovered).toBe(true);
    // 止まったあとも読み進めているので、目録には届いている
    expect(scope.continuedPastStop).toBe(true);
    expect(scope.reconstructed).toBe(false);
  });

  it('`/Prev` が整数でない文書は malformed として止まる（prev-zero と別）', async () => {
    const scope = await open('malformed');
    expect(scope.chainStop.kind).toBe('malformed');
    expect(scope.recovered).toBe(true);
    expect(scope.reconstructed).toBe(false);
  });

  it('相互参照節が 1 つも読めない文書では、表を組み直したと申告する', async () => {
    const scope = await open('unreadableTable');
    expect(scope.chainStop.kind).toBe('unreadable');
    expect(scope.reconstructed).toBe(true);
    expect(scope.newestSectionUnreadable).toBe(true);
    // 組み直した表なので、条文に反していることは既に分かっている
    expect(scope.refusal).toMatch(/§7\.5\.4|§7\.5\.8/);
    expect(scope.objects).toBeGreaterThan(0);
  });

  it('🔴 4 通りは互いに違う値を返す（どれかに畳まれていない）', async () => {
    const kinds = await Promise.all(
      (['complete', 'cyclic', 'malformed', 'unreadableTable'] as const).map(
        async (n) => (await open(n)).chainStop.kind,
      ),
    );
    expect(new Set(kinds).size).toBe(4);
  });
});

describe('ReadingScope — 出力に載る形', () => {
  it('報告の先頭に scope が来る（JSON の鍵の順）', async () => {
    const report = identifyConformance(await parsePdfBytes(toBytes(specimens.complete())));
    expect(Object.keys(report)[0]).toBe('scope');
    expect(report.scope.reconstructed).toBe(false);
  });

  it('COS 辞書は出力に出さない（JSON にすると内部表現が出るため）', async () => {
    const report = identifyConformance(await parsePdfBytes(toBytes(specimens.complete())));
    expect('encryptDict' in report.scope).toBe(false);
    // 出力は必ず JSON になる。COS オブジェクトが混ざっていれば、ここで壊れる
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it('表を組み直した文書は、報告の文でそう言う', async () => {
    const report = identifyConformance(await parsePdfBytes(toBytes(specimens.unreadableTable())));
    expect(report.scope.reconstructed).toBe(true);
    const markdown = formatReadingScope(report.scope).join('\n');
    expect(markdown).toMatch(/rebuilt by this tool/);
    expect(markdown).toMatch(/not the table the file carries/);
  });

  it('🔴 健全な文書では、その文が出ない（空振り検査の対）', async () => {
    const report = identifyConformance(await parsePdfBytes(toBytes(specimens.complete())));
    const markdown = formatReadingScope(report.scope).join('\n');
    expect(markdown).not.toMatch(/rebuilt by this tool/);
    expect(markdown).toMatch(/Scope of this reading/);
  });

  it('sections は健全な文書でも数えてある（0 は「数えていない」の意味ではない）', async () => {
    const report = identifyConformance(await parsePdfBytes(toBytes(specimens.complete())));
    expect(report.scope.sections).toBeGreaterThan(0);
  });
});

describe('条文を名指しする拒否は、サーバの故障ではない', () => {
  async function writeSpecimen(name: keyof typeof specimens): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'pdf-verify-scope-'));
    const file = join(dir, `${name}.pdf`);
    await writeFile(file, Buffer.from(specimens[name](), 'latin1'));
    return file;
  }

  it('🔴 相互参照節が条文に反する文書は PARSE_FAILED であって INTERNAL_ERROR ではない', async () => {
    const file = await writeSpecimen('unreadableTable');
    await expect(validateClauses(file)).rejects.toThrow(PdfVerifyError);
    const error = await validateClauses(file).catch((e: unknown) => e as PdfVerifyError);
    // INTERNAL_ERROR だと、受け側は「調べられませんでした」の枠に落とす
    expect(error.code).toBe('PARSE_FAILED');
    expect(error.message).toMatch(/§7\.5\.4|§7\.5\.8/);
    expect(error.suggestion).toMatch(/finding about the file, not a failure of this server/);
  });

  it('条文どおりの文書では、そもそも拒否されない（空振り検査の対）', async () => {
    const file = await writeSpecimen('complete');
    const report = await validateClauses(file);
    expect(report.scope.reconstructed).toBe(false);
    expect(Object.keys(report)[0]).toBe('scope');
  });
});

describe('署名の一覧を返す 2 本も射程を持つ（0.21.0）', () => {
  it('🔴 「署名が無い」と「読めた範囲に署名が無い」を、同じ場所で見分けられる', async () => {
    const parsed = await parsePdfBytes(toBytes(specimens.unreadableTable()));
    expect(parsed.scope.reconstructed).toBe(true);
    const markdown = formatSignatureReports({
      scope: toReadingScope(parsed.scope),
      signatures: [],
    });
    // 署名が 0 本でも、射程は消えない
    expect(markdown).toMatch(/No signatures found/);
    expect(markdown).toMatch(/rebuilt by this tool/);
  });

  it('条文どおりの文書では、その文は出ない（空振り検査の対）', async () => {
    const parsed = await parsePdfBytes(toBytes(specimens.complete()));
    const markdown = formatSignatureReports({
      scope: toReadingScope(parsed.scope),
      signatures: [],
    });
    expect(markdown).toMatch(/No signatures found/);
    expect(markdown).not.toMatch(/rebuilt by this tool/);
  });

  it('detect_pades_level も同じ形で射程を持つ', async () => {
    const parsed = await parsePdfBytes(toBytes(specimens.unreadableTable()));
    const result = {
      scope: toReadingScope(parsed.scope),
      levels: await detectPadesLevels(parsed),
    };
    expect(Object.keys(result)[0]).toBe('scope');
    expect(formatPadesReports(result)).toMatch(/rebuilt by this tool/);
  });
});
