/**
 * verify_integrity core logic tests.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { analyzeIntegrity } from '../../src/services/verification-service.js';
import { formatIntegrityReport } from '../../src/utils/formatter.js';
import { createLinearizedPdf } from '../helpers/linearized-pdf.js';
import {
  appendIncrementalUpdate,
  appendObjectRevision,
  createSignedPdf,
  createTestIdentity,
  type TestIdentity,
} from '../helpers/signed-pdf.js';

let identity: TestIdentity;
let signedPdf: Uint8Array;

beforeAll(async () => {
  identity = await createTestIdentity();
  signedPdf = await createSignedPdf(identity);
});

describe('analyzeIntegrity', () => {
  it('clean signed PDF: one revision, signature covers file', async () => {
    const parsed = await parsePdfBytes(signedPdf);
    const report = await analyzeIntegrity(parsed);

    expect(report.signatureCount).toBe(1);
    expect(report.revisionCount).toBe(1);
    expect(report.incrementalUpdateCount).toBe(0);
    expect(report.lastSignatureCoversFile).toBe(true);
    expect(report.signaturesWithLaterChanges).toHaveLength(0);
  });

  it('detects bytes appended after signing', async () => {
    const appended = appendIncrementalUpdate(signedPdf);
    const parsed = await parsePdfBytes(appended);
    const report = await analyzeIntegrity(parsed);

    expect(report.revisionCount).toBe(2);
    expect(report.incrementalUpdateCount).toBe(1);
    expect(report.lastSignatureCoversFile).toBe(false);
    expect(report.signaturesWithLaterChanges).toHaveLength(1);
    expect(report.signaturesWithLaterChanges[0].bytesAfterSignedRange).toBeGreaterThan(0);
  });

  it('reports DocMDP certification and violation', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 1 });

    const cleanReport = await analyzeIntegrity(await parsePdfBytes(certified));
    expect(cleanReport.certification?.permission).toBe(1);
    expect(cleanReport.certification?.violatedByLaterChanges).toBe(false);

    const modified = appendIncrementalUpdate(certified);
    const modifiedReport = await analyzeIntegrity(await parsePdfBytes(modified));
    expect(modifiedReport.certification?.violatedByLaterChanges).toBe(true);
    expect(modifiedReport.certification?.laterChangesAppearLtvOnly).toBe(false);
  });

  it('does not flag P=1 when later changes appear to be DSS/DTS (ISO 32000-2 §12.8.2.2)', async () => {
    // Certified (P=1) document that carries a DSS: later incremental updates
    // are treated as the permitted DSS/document-timestamp exception.
    const certified = await createSignedPdf(identity, {
      docMdpPermission: 1,
      dss: { certs: [new Uint8Array(identity.certificate.toSchema(true).toBER(false))] },
    });

    const modified = appendIncrementalUpdate(certified);
    const report = await analyzeIntegrity(await parsePdfBytes(modified));
    expect(report.certification?.permission).toBe(1);
    expect(report.certification?.violatedByLaterChanges).toBe(false);
    expect(report.certification?.laterChangesAppearLtvOnly).toBe(true);
    expect(report.notes.join(' ')).toMatch(/12\.8\.2\.2/);
  });
});

/**
 * DocMDP against what P actually grants (ISO 32000-2 Table 257), not only P=1.
 *
 * 🔴 Until 0.14.0 the check began with `permission === 1`, so **P=2 and P=3
 * could never be violated**. The three tests below are the same appended
 * annotation judged at each permission — the discriminating triple.
 */
describe('analyzeIntegrity — DocMDP P=2 / P=3', () => {
  const annotation = {
    objectNumber: 8,
    body: '<< /Type /Annot /Subtype /Text /Rect [ 400 700 420 720 ] /Contents (added after signing) >>',
  };
  const widget = {
    objectNumber: 8,
    body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /Rect [ 100 700 200 720 ] /V (1,000) >>',
  };

  it('flags an annotation appended to a P=2 document (Table 257 grants it only from P=3)', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 2 });
    const report = await analyzeIntegrity(
      await parsePdfBytes(appendObjectRevision(certified, { objects: [annotation] })),
    );
    expect(report.certification?.permission).toBe(2);
    expect(report.certification?.violationAssessment).toBe('violated');
    expect(report.certification?.violatedByLaterChanges).toBe(true);
    expect(report.certification?.assessmentReason).toMatch(/outside what P=2 permits/);
  });

  it('does NOT flag the same annotation on a P=3 document', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 3 });
    const report = await analyzeIntegrity(
      await parsePdfBytes(appendObjectRevision(certified, { objects: [annotation] })),
    );
    expect(report.certification?.permission).toBe(3);
    expect(report.certification?.violationAssessment).toBe('permitted');
    expect(report.certification?.violatedByLaterChanges).toBe(false);
  });

  it('does NOT flag a form-field widget on a P=2 document ("filling in forms")', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 2 });
    const report = await analyzeIntegrity(
      await parsePdfBytes(appendObjectRevision(certified, { objects: [widget] })),
    );
    expect(report.certification?.violationAssessment).toBe('permitted');
  });

  it('flags a page content stream on a P=3 document (no P value permits it)', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 3 });
    const report = await analyzeIntegrity(
      await parsePdfBytes(
        appendObjectRevision(certified, {
          objects: [
            { objectNumber: 8, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
          ],
        }),
      ),
    );
    expect(report.certification?.violationAssessment).toBe('violated');
  });

  it('reports indeterminate — not permitted — when a changed object cannot be typed', async () => {
    // An object whose kind cannot be read must not be counted as harmless.
    // "Could not be disproved" is a different statement from "is fine".
    const certified = await createSignedPdf(identity, { docMdpPermission: 2 });
    const report = await analyzeIntegrity(
      await parsePdfBytes(
        appendObjectRevision(certified, { objects: [{ objectNumber: 8, body: '42' }] }),
      ),
    );
    expect(report.certification?.violationAssessment).toBe('indeterminate');
    // 🔴 The boolean collapses indeterminate to false. That is exactly why the
    // three-valued field exists, and why callers must not read the boolean alone.
    expect(report.certification?.violatedByLaterChanges).toBe(false);
    expect(report.notes.join(' ')).toMatch(/not a pass/);
  });

  it('reports indeterminate when bytes were appended but the chain cannot be walked', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 2 });
    // appendIncrementalUpdate writes startxref 0 — the newest section is unreadable
    const report = await analyzeIntegrity(await parsePdfBytes(appendIncrementalUpdate(certified)));
    expect(report.certification?.violationAssessment).toBe('indeterminate');
  });
});

/**
 * Issue #8 / family gap G-B — the object-level view of the update chain.
 * Every assertion here is about *observation*: no verdict may move because of
 * it, which the last test in this block pins down explicitly.
 */
describe('analyzeIntegrity — object-level revision diff', () => {
  /** signed → add obj 8 → rewrite obj 8 and add obj 9 → free obj 9 */
  async function buildChain(): Promise<Uint8Array> {
    const added = appendObjectRevision(signedPdf, {
      objects: [
        {
          objectNumber: 8,
          body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /Rect [ 100 700 200 720 ] /V (1,000) >>',
        },
      ],
    });
    const rewritten = appendObjectRevision(added, {
      objects: [
        {
          objectNumber: 8,
          body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Amount) /Rect [ 100 700 200 720 ] /V (9,000,000) >>',
        },
        { objectNumber: 9, body: '<< /Length 10 >>\nstream\nBT /F1 ET\nendstream' },
      ],
    });
    return appendObjectRevision(rewritten, { freed: [9] });
  }

  it('names the objects each incremental update added, rewrote and freed', async () => {
    const report = await analyzeIntegrity(await parsePdfBytes(await buildChain()));
    const revisions = report.revisions;
    expect(revisions).not.toBeNull();
    if (!revisions) return;
    expect(revisions).toHaveLength(4);

    // The original revision has nothing older to compare against.
    expect(revisions[0].changes).toBeNull();

    expect(revisions[1].changes).toEqual([
      expect.objectContaining({
        objectNumber: 8,
        change: 'added',
        type: 'Annot',
        subtype: 'Widget',
        bookkeeping: false,
      }),
    ]);
    expect(revisions[2].changes).toEqual([
      expect.objectContaining({ objectNumber: 8, change: 'modified', type: 'Annot' }),
      expect.objectContaining({ objectNumber: 9, change: 'added' }),
    ]);
    expect(revisions[3].changes).toEqual([
      expect.objectContaining({ objectNumber: 9, change: 'freed' }),
    ]);
  });

  it('reads the role of a changed object from that revision, not from pdf-lib', async () => {
    const report = await analyzeIntegrity(await parsePdfBytes(await buildChain()));
    const widget = report.revisions?.[1].changes?.[0];
    expect(widget?.role).toMatch(/form field widget/);
    // Object 9 is a bare stream: no /Type to read, so the role is a guess from
    // the keys and must stay a guess.
    const stream = report.revisions?.[2].changes?.find((c) => c.objectNumber === 9);
    expect(stream?.type).toBeNull();
    expect(stream?.role).toMatch(/stream/);
  });

  it('shortlists the objects written after the last signed range', async () => {
    const report = await analyzeIntegrity(await parsePdfBytes(await buildChain()));
    const numbers = report.objectChangesAfterLastSignature.map((c) => c.objectNumber);
    // Every revision after the first was appended past the signed range.
    expect(numbers).toEqual([8, 8, 9, 9]);
  });

  it('says "not determined" rather than "unchanged" when the chain is unwalkable', async () => {
    // appendIncrementalUpdate writes `startxref 0`, which points nowhere. The
    // chain is then entered from an older section and the trailing bytes are
    // not represented — that has to be said out loud.
    const report = await analyzeIntegrity(await parsePdfBytes(appendIncrementalUpdate(signedPdf)));
    expect(report.notes.join(' ')).toMatch(/does not point at a parseable cross-reference section/);
  });

  it('leaves every existing verdict untouched', async () => {
    const chain = await buildChain();
    const report = await analyzeIntegrity(await parsePdfBytes(chain));
    // The same facts as before the diff existed: appending objects after a
    // signature is legal, so nothing about the signature's status changes.
    expect(report.signatureCount).toBe(1);
    expect(report.lastSignatureCoversFile).toBe(false);
    expect(report.certification).toBeNull();
    expect(report.signaturesWithLaterChanges).toHaveLength(1);
  });
});

/**
 * Two ways the chain walk used to be wrong, both found by A/B-ing the
 * hand-rolled walker against normativepdf over every PDF in the repository
 * (2987 files, 14 differences). Neither was caught by the tests above, because
 * every fixture here is a well-formed pdf-lib file walked from byte 0 — the two
 * faces that carry the difference were not being measured at all.
 */
describe('analyzeIntegrity — how the cross-reference chain is walked', () => {
  /**
   * Rewrite the newest trailer's `/Prev N` to `/Prev 0`, padded with spaces so
   * that no byte offset in the file moves (white space is a separator, §7.2.3).
   *
   * `/Prev 0` is not "there is no previous section": §7.5.5 Table 15 defines
   * Prev as the byte offset of the previous cross-reference section, and offset
   * 0 is the file header. It is a link that cannot be followed. Real files do
   * this — `docs/specimens/dss-pades-5sigs-doctimestamp.pdf` is a 5-signature
   * document with 8 revisions whose newest trailer says `/Prev 0`.
   */
  function blankNewestPrev(pdf: Uint8Array): Uint8Array {
    const text = Buffer.from(pdf).toString('latin1');
    const match = [...text.matchAll(/\/Prev (\d+)/g)].pop();
    if (!match?.index) throw new Error('fixture has no /Prev to blank');
    const padded = '/Prev 0'.padEnd(match[0].length, ' ');
    const out = Buffer.from(
      text.slice(0, match.index) + padded + text.slice(match.index + match[0].length),
      'latin1',
    );
    if (out.length !== pdf.length) throw new Error('blanking /Prev moved a byte offset');
    return new Uint8Array(out);
  }

  /**
   * Put bytes in front of the `%PDF-` header. ISO 32000-2 §7.5.2: "byte offsets
   * shall be calculated from the PERCENT SIGN", so every offset inside the file
   * stays correct and the document is still well-formed — the origin is simply
   * no longer 0. (The PDF Association ships such a specimen: "PDF 2.0 with
   * offset start.pdf".)
   */
  function shiftOrigin(pdf: Uint8Array, lead: string): Uint8Array {
    const head = Buffer.from(lead, 'latin1');
    const out = new Uint8Array(head.length + pdf.length);
    out.set(head, 0);
    out.set(pdf, head.length);
    return out;
  }

  const annotation = {
    objectNumber: 8,
    body: '<< /Type /Annot /Subtype /Text /Rect [ 400 700 420 720 ] /Contents (later) >>',
  };

  it('says a `/Prev 0` chain was cut short instead of calling it a one-revision file', async () => {
    const chain = appendObjectRevision(signedPdf, { objects: [annotation] });
    expect((await analyzeIntegrity(await parsePdfBytes(chain))).revisions).toHaveLength(2);

    const report = await analyzeIntegrity(await parsePdfBytes(blankNewestPrev(chain)));

    // Only the newest section is reachable now — that much is unavoidable, and
    // it is why the *reporting* is the whole point: one revision is listed for
    // a file that demonstrably has more.
    expect(report.revisions).toHaveLength(1);
    // 🔴 The previous implementation read `/Prev 0`, let a `next > 0` loop
    // guard drop it, and left the chain marked complete.
    expect(report.notes.join(' ')).toMatch(/chain ended before reaching the original revision/);
  });

  it('does not let a `/Prev 0` chain answer a DocMDP question with the wrong reason', async () => {
    const certified = await createSignedPdf(identity, { docMdpPermission: 2 });
    const chain = appendObjectRevision(certified, { objects: [annotation] });
    // Intact, the appended annotation is a P=2 violation (Table 257 grants
    // annotation creation only from P=3).
    const intact = await analyzeIntegrity(await parsePdfBytes(chain));
    expect(intact.certification?.violationAssessment).toBe('violated');

    const report = await analyzeIntegrity(await parsePdfBytes(blankNewestPrev(chain)));

    expect(report.certification?.violationAssessment).toBe('indeterminate');
    // 🔴 Both implementations land on `indeterminate` here, but for different
    // reasons, and the reason is the part that is true or false. The old walker
    // claimed a complete chain, so it got there via "no changed object could be
    // listed" — which reads as "we looked and found nothing". What actually
    // happened is that the chain could not be followed, and only that reason
    // tells a reviewer there is more file to go and look at.
    expect(report.certification?.assessmentReason).toMatch(/revision chain is incomplete/);
  });

  /**
   * V-F5. The tool description used to warn only about `revisions: null`, so a
   * returned list read as the whole history. It is not: when the chain is cut,
   * the list comes back **non-null and non-empty**, and the revision that
   * survives is reported as the ORIGINAL one — `changeCount: 0`, `changes: null`.
   * Every machine-readable field then says "nothing was appended" about a file
   * that demonstrably had an append.
   *
   * V-F6 (0.16.0) gave this a field. Before it, the only signal was English
   * prose in `notes`, so a caller had to match strings to decide whether it
   * could promise a full history — `pdf-trust`'s legal / medical profiles did
   * exactly that. The prose stays (a human reads the cause there); the field
   * carries the consequence, which is what a machine branches on.
   */
  it('a returned revisions list is not evidence that nothing was appended', async () => {
    const chain = appendObjectRevision(signedPdf, { objects: [annotation] });

    const intact = await analyzeIntegrity(await parsePdfBytes(chain));
    expect(intact.revisions).toHaveLength(2);
    expect(intact.revisions?.[1].changes).toEqual([
      expect.objectContaining({ objectNumber: annotation.objectNumber, change: 'added' }),
    ]);

    const cut = await analyzeIntegrity(await parsePdfBytes(blankNewestPrev(chain)));

    // 🔴 Not null, not empty — "a list came back" is not "the whole file was read".
    expect(cut.revisions).not.toBeNull();
    expect(cut.revisions).toHaveLength(1);
    // The append is gone from every field: the surviving revision is treated as
    // the original, so there is nothing to compare it against.
    expect(cut.revisions?.[0].changeCount).toBe(0);
    expect(cut.revisions?.[0].changes).toBeNull();
    expect(cut.objectChangesAfterLastSignature).toEqual([]);

    // The one field a caller branches on. `partial` — not `complete`, and not
    // the `unwalkable` that a null list would give.
    expect(cut.revisionChain).toEqual({ status: 'partial', missing: ['oldest'] });
    // The cause stays in the prose.
    expect(cut.notes.join(' ')).toMatch(/chain ended before reaching the original revision/);

    // 🔴 The same file read as complete before the cut. If this stopped being
    // `complete`, the field would be reporting the flag rather than the fact.
    expect(intact.revisionChain).toEqual({ status: 'complete', missing: [] });
  });

  /**
   * `unwalkable` is a third state, not a flavour of `partial`. A caller that
   * treats "missing is empty" as "nothing is missing" would read a file whose
   * chain could not be entered at all as a complete history, which is the
   * misreading `violationAssessment: 'indeterminate'` exists to prevent
   * elsewhere in this report.
   */
  it('names both ends absent when no cross-reference section could be read', async () => {
    const chain = appendObjectRevision(signedPdf, { objects: [annotation] });
    const text = Buffer.from(chain).toString('latin1');
    // Point every `startxref` at an offset with no cross-reference section,
    // padded so that nothing else in the file moves (§7.2.3: white space is a
    // separator). Measured on tests/fixtures/generated/appended.pdf: this is
    // what makes `walkChain` return null.
    const wrecked = Buffer.from(
      text.replace(/startxref\s*\r?\n\d+/g, (m) => 'startxref\n1'.padEnd(m.length, ' ')),
      'latin1',
    );
    expect(wrecked.length).toBe(chain.length);

    const report = await analyzeIntegrity(await parsePdfBytes(new Uint8Array(wrecked)));

    expect(report.revisions).toBeNull();
    expect(report.revisionChain.status).toBe('unwalkable');
    expect(report.revisionChain.missing).toEqual(['oldest', 'newest']);
  });

  it('walks a file whose header does not start at byte 0 (§7.5.2)', async () => {
    const lead = '%!PS-Adobe-3.0\n% wrapper bytes before the PDF header\n';
    const shifted = shiftOrigin(signedPdf, lead);

    const report = await analyzeIntegrity(await parsePdfBytes(shifted));

    // 🔴 The previous implementation treated every startxref value as an
    // absolute file position, so it landed short of the section and gave up:
    // revisions came back null, i.e. "not determined", for a perfectly
    // well-formed document.
    expect(report.revisions).not.toBeNull();
    expect(report.revisions).toHaveLength(1);

    // Offsets are reported absolute — what a reviewer opening the file needs —
    // so each one moves by exactly the number of bytes put in front.
    const unshifted = await analyzeIntegrity(await parsePdfBytes(signedPdf));
    expect(report.revisions?.[0].xrefOffset).toBe(
      (unshifted.revisions?.[0].xrefOffset ?? 0) + lead.length,
    );
  });
});

/**
 * V-F7. `revisionCount` counts `startxref` keywords; `revisions` lists the
 * cross-reference sections the chain reached. The two differ lawfully, and
 * until 0.17.0 the report said only that they "differ legitimately in
 * linearised files and in files carrying a cross-reference section no chain
 * points at" — both causes side by side, neither claimed, in prose. The walker
 * had already decided which one applied and dropped the answer at the exit.
 *
 * 🔴 The linearisation branch had no fixture at all before this: nothing under
 * `tests/` or `docs/` contained the string `Linearized`, so the merge of the
 * first-page and main sections was never executed by a test.
 */
describe('analyzeIntegrity — the two revision counts', () => {
  const linearized = createLinearizedPdf();

  it('names the linearisation as what accounts for the difference', async () => {
    const parsed = await parsePdfBytes(linearized);
    const report = await analyzeIntegrity(parsed);

    // Two `startxref` keywords (F.3.4 writes one after the first-page trailer,
    // F.3.11 one at the end) describing ONE save.
    expect(parsed.revisionCount).toBe(2);
    expect(report.revisions).toHaveLength(1);
    // Nothing is missing: the merge is a correction, not a loss.
    expect(report.revisionChain).toEqual({ status: 'complete', missing: [] });

    expect(report.revisionCountAgreement).toEqual({
      status: 'accounted',
      causes: ['linearised'],
    });
    // 🔴 The prose used to stop at "linearised files and files carrying a
    // cross-reference section no chain points at". It now says which.
    expect(report.notes.join(' ')).toMatch(
      /What accounts for the difference: the file's linearisation/,
    );
    expect(report.notes.join(' ')).not.toMatch(/no chain points at/);
  });

  /**
   * The counter-check for the one above: a file with no linearisation and a
   * chain that was walked in full has to come back `agree` with nothing named,
   * and the note must not appear at all. Without this, `status: 'accounted'`
   * would still pass if the field were hard-wired to it.
   */
  it('says the counts agree for an ordinary single-revision file', async () => {
    const report = await analyzeIntegrity(await parsePdfBytes(signedPdf));

    expect(report.revisionCount).toBe(1);
    expect(report.revisions).toHaveLength(1);
    expect(report.revisionCountAgreement).toEqual({ status: 'agree', causes: [] });
    expect(report.notes.join(' ')).not.toMatch(/"startxref" keyword\(s\) are present/);
  });

  it('names an incomplete chain as what accounts for the difference', async () => {
    // Two revisions, then the newest trailer's `/Prev` blanked: the chain stops
    // after one section while both `startxref` keywords are still in the file.
    const chain = appendObjectRevision(signedPdf, {
      objects: [{ objectNumber: 8, body: '<< /Type /Annot /Subtype /Text /Rect [ 0 0 1 1 ] >>' }],
    });
    const text = Buffer.from(chain).toString('latin1');
    const match = [...text.matchAll(/\/Prev (\d+)/g)].pop();
    if (!match?.index) throw new Error('fixture has no /Prev to blank');
    const cut = new Uint8Array(
      Buffer.from(
        text.slice(0, match.index) +
          '/Prev 0'.padEnd(match[0].length, ' ') +
          text.slice(match.index + match[0].length),
        'latin1',
      ),
    );

    const report = await analyzeIntegrity(await parsePdfBytes(cut));

    expect(report.revisionCount).toBe(2);
    expect(report.revisions).toHaveLength(1);
    expect(report.revisionCountAgreement).toEqual({
      status: 'accounted',
      causes: ['chain-incomplete'],
    });
    // Which end is absent is `revisionChain`'s answer and is not repeated.
    expect(report.revisionChain).toEqual({ status: 'partial', missing: ['oldest'] });
  });

  /**
   * The third state, and the reason this is a field rather than a boolean:
   * the counts differ, the chain was walked in full, and the file is not
   * linearised. Nothing read from the file accounts for it — which is the case
   * a reviewer should go and look at, and the one a `linearized: boolean`
   * would have left to the caller to work out from three other fields.
   */
  it('says so when nothing read from the file accounts for the difference', async () => {
    // A second `startxref` pointing at the section the first one already names.
    // The keyword count goes up; the chain still reaches exactly one section.
    const offset = Buffer.from(signedPdf)
      .toString('latin1')
      .match(/startxref\s*\r?\n(\d+)/)?.[1];
    if (!offset) throw new Error('fixture has no startxref');
    const extra = Buffer.from(`startxref\n${offset}\n%%EOF\n`, 'latin1');
    const doubled = new Uint8Array(signedPdf.length + extra.length);
    doubled.set(signedPdf, 0);
    doubled.set(extra, signedPdf.length);

    const report = await analyzeIntegrity(await parsePdfBytes(doubled));

    expect(report.revisionCount).toBe(2);
    expect(report.revisions).toHaveLength(1);
    expect(report.revisionChain).toEqual({ status: 'complete', missing: [] });
    expect(report.revisionCountAgreement).toEqual({ status: 'unaccounted', causes: [] });
    expect(report.notes.join(' ')).toMatch(
      /Nothing read from the file accounts for the difference/,
    );
  });

  it('puts the reconciliation next to the count in the markdown report', async () => {
    const report = await analyzeIntegrity(await parsePdfBytes(linearized));
    const lines = formatIntegrityReport(report).split('\n');

    const countAt = lines.findIndex((line) => line.startsWith('- Revisions:'));
    const reconciledAt = lines.findIndex((line) => line.startsWith('- Revision count:'));
    // Same reason as `revisionChain`'s line: a reader who meets "Revisions: 2"
    // has formed a view of the file before a note at the bottom corrects it.
    expect(countAt).toBeGreaterThanOrEqual(0);
    expect(reconciledAt).toBe(countAt + 2);
    expect(lines[reconciledAt]).toMatch(/the file is linearised/);

    // Nothing to reconcile, nothing printed.
    const ordinary = await analyzeIntegrity(await parsePdfBytes(signedPdf));
    expect(formatIntegrityReport(ordinary)).not.toMatch(/- Revision count:/);
  });
});

/**
 * The builder above is this repository's reading of Annex F. A real linearizer
 * is the check on that reading: if qpdf's output and the hand-built one give
 * different answers, the fixture is what is wrong, not the file.
 *
 * Skips where qpdf is absent; CI installs it (`.github/workflows/ci.yml`).
 */
const describeQpdf = (() => {
  try {
    execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
    return describe;
  } catch {
    return describe.skip;
  }
})();

describeQpdf('analyzeIntegrity — a linearised file from a real linearizer', () => {
  it('reads a qpdf --linearize output the same way as the hand-built fixture', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdf-verify-linearized-'));
    await writeFile(join(dir, 'plain.pdf'), signedPdf);
    // 🔴 --warning-exit-0: qpdf exits with 3 when it emits a warning, and what
    // it warns about differs by version — qpdf 12 repairs this fixture's
    // missing page /Resources ("operation succeeded with warnings") where 10.6
    // and 11.9 say nothing, so without the flag this test passes or fails on
    // the qpdf version, not on the code. A warned run still writes the
    // linearised file, which is all this test reads.
    execFileSync('qpdf', ['--warning-exit-0', '--linearize', 'plain.pdf', 'linearized.pdf'], {
      cwd: dir,
    });
    const bytes = new Uint8Array(await readFile(join(dir, 'linearized.pdf')));

    const parsed = await parsePdfBytes(bytes);
    const report = await analyzeIntegrity(parsed);

    expect(parsed.revisionCount).toBe(2);
    expect(report.revisions).toHaveLength(1);
    expect(report.revisionChain).toEqual({ status: 'complete', missing: [] });
    expect(report.revisionCountAgreement).toEqual({
      status: 'accounted',
      causes: ['linearised'],
    });
  });
});
