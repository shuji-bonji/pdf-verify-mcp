/**
 * 値が `null` の辞書エントリ（ISO 32000-2 §7.3.7）が、判定まで届くことを固定する。
 *
 *   "A dictionary entry whose value is null shall be treated the same as if
 *    the entry does not exist."
 *
 * `@normativepdf/recover` 0.1.0 の `has()` はこの条文を当てておらず、
 * `has(descriptor, 'FontFile2')` が `/FontFile2 null` に「ある」と答えていた。
 * 0.1.1 で直っている。ここは**その直しが判定に届いているか**を見る。
 *
 * 検体は `.golden/specimens/nullentry-*.pdf` と**同じ組み立て**を読む
 * （`scripts/lib/null-entry-specimen-builder.mjs`）。検体とテストが別々の作り方を
 * していると、片方だけ狙いを外しても気づけない。
 *
 * コーパス側でこの軸を踏むのは veraPDF の `6-2-10-4-1-t01-{pass,fail}-a.pdf` の
 * 2 件だけで、どちらも `/FontFile3 null`（「在るべき鍵」の向き）である。
 * **「在ってはならない鍵」の向きを踏む検体は 1 件も無い**ので、ここで作る。
 *
 * 🔴 **2 件は対である。** 値が `null` のほうと、値が入っているほうで
 * **答えが逆になる**ことを同じ表で確かめる。片方だけ見ると、
 * 「常に fail を返す」実装でも緑になる。
 *
 * | 検体 | 文字の出し方 | fonts-embedded | no-aa-catalog |
 * |---|---|---|---|
 * | `nullValuedEntry`     | 見える（既定） | fail | pass |
 * | `nullValuedInvisible` | `3 Tr`（不可視） | **pass** | pass |
 * | `valuedEntry`         | 見える | pass | fail |
 *
 * recover 0.1.0 では 1 行目と 3 行目が「pass / fail」で揃っていて、
 * **2 件を区別できなかった**（2026-08-29 実測）。
 * 2 行目は 0.25.0 で `fonts-embedded` が**使われ方**を見るようになって分かれた
 * —— 埋め込まれていないのは同じでも、不可視でしか出していなければ違反ではない。
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — 検体の組み立ては .mjs で、型宣言を持たない
import { specimens } from '../../scripts/lib/null-entry-specimen-builder.mjs';
import { validateConformance } from '../../src/services/conformance-validation.js';
import { parsePdf } from '../../src/services/pdf-parser.js';

async function rulesOf(name: keyof typeof specimens): Promise<Map<string, boolean>> {
  const dir = await mkdtemp(join(tmpdir(), 'nullentry-'));
  const path = join(dir, `${String(name)}.pdf`);
  await writeFile(path, Buffer.from(specimens[name](), 'latin1'));
  const report = await validateConformance(await parsePdf(path), path, { engine: 'native' });
  const failed = new Set((report.violations ?? []).map((v) => v.ruleId));
  return new Map(['fonts-embedded', 'no-aa-catalog'].map((id) => [id, !failed.has(id)]));
}

describe('値が null のエントリは、エントリが無いのと同じ（§7.3.7）', () => {
  it('/FontFile2 null は「埋め込まれていない」—— fonts-embedded が fail する', async () => {
    expect((await rulesOf('nullValuedEntry')).get('fonts-embedded')).toBe(false);
  });

  it('/FontFile2 が実在するストリームを指せば pass する（空振り検査の対）', async () => {
    expect((await rulesOf('valuedEntry')).get('fonts-embedded')).toBe(true);
  });

  it('/AA null は「AA が無い」—— no-aa-catalog が pass する', async () => {
    expect((await rulesOf('nullValuedEntry')).get('no-aa-catalog')).toBe(true);
  });

  it('/AA << >> なら fail する（空振り検査の対）', async () => {
    expect((await rulesOf('valuedEntry')).get('no-aa-catalog')).toBe(false);
  });

  it('🔴 不可視（3 Tr）でしか出していなければ違反ではない', async () => {
    // 埋め込まれていないのは nullValuedEntry と同じ。違うのは出し方だけ
    expect((await rulesOf('nullValuedInvisible')).get('fonts-embedded')).toBe(true);
  });

  it('🔴 3 件は同じ答えに畳まれていない', async () => {
    const nul = await rulesOf('nullValuedEntry');
    const inv = await rulesOf('nullValuedInvisible');
    const val = await rulesOf('valuedEntry');
    // 埋め込みは「値が null か」と「見えるように出したか」の 2 つで決まる
    expect(nul.get('fonts-embedded')).toBe(false);
    expect(inv.get('fonts-embedded')).toBe(true);
    expect(val.get('fonts-embedded')).toBe(true);
    // /AA のほうは値が null かだけで決まる
    expect(nul.get('no-aa-catalog')).not.toBe(val.get('no-aa-catalog'));
  });
});
