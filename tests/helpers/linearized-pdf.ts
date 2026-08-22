/**
 * A linearised PDF (ISO 32000-2 Annex F), built byte by byte.
 *
 * `walkChain` has a branch for linearisation: a linearised file writes TWO
 * cross-reference sections for ONE save — the first-page section near the top,
 * whose `/Prev` points at the main section at the bottom — and walking that
 * naively turns one save into two revisions, reporting every object as added.
 * Until V-F7 no fixture in this repository was linearised, so that branch was
 * never executed by a test.
 *
 * qpdf `--linearize` produces the real thing and `verify-integrity.test.ts`
 * uses it where qpdf is installed. This builder exists so the branch is
 * measured **without** an external tool as well, and so the shape is written
 * down where it can be read.
 *
 * What is faithful here: the part order of Annex F clause F.3, the first-page
 * cross-reference table with its `/Prev` to the main table (F.3.4), the main
 * table as a single subsection starting at object 0 (F.3.11), the linearisation
 * parameter dictionary inside the first 1024 bytes with every entry of Table
 * F.1 filled in from measured offsets (F.3.3), and the two `startxref`
 * keywords a linearised file carries.
 *
 * What is NOT faithful: the primary hint stream's *contents*. `/H` points at a
 * real stream object of the right length, but its bytes are not a page-offset
 * hint table (F.4). Nothing in this server reads hint data — it walks
 * cross-reference sections — so the fixture is faithful in the part that is
 * measured and says so in the part that is not.
 */

/** Object numbers, in the two groups the two cross-reference tables cover. */
const MAIN_OBJECTS = [1] as const; // page tree: reached only by the main table
const FIRST_PAGE_OBJECTS = [2, 3, 4, 5, 6] as const; // dict, catalog, page, contents, hint
const SIZE = MAIN_OBJECTS.length + FIRST_PAGE_OBJECTS.length + 1; // + the free entry

/**
 * Every number that can only be known once the layout is fixed. All of them are
 * written as ten digits, so the second pass cannot move a single byte.
 */
interface Layout {
  fileLength: number;
  hintOffset: number;
  hintLength: number;
  firstPageEnd: number;
  mainTableFirstEntry: number;
  mainXrefOffset: number;
  firstPageXrefOffset: number;
  objectOffsets: Map<number, number>;
}

const OFFSET_DIGITS = 10;

function pad(value: number): string {
  return String(value).padStart(OFFSET_DIGITS, '0');
}

function emptyLayout(): Layout {
  return {
    fileLength: 0,
    hintOffset: 0,
    hintLength: 0,
    firstPageEnd: 0,
    mainTableFirstEntry: 0,
    mainXrefOffset: 0,
    firstPageXrefOffset: 0,
    objectOffsets: new Map([...MAIN_OBJECTS, ...FIRST_PAGE_OBJECTS].map((n) => [n, 0])),
  };
}

function streamObject(objectNumber: number, body: string): string {
  const length = Buffer.byteLength(body, 'latin1');
  return `${objectNumber} 0 obj\n<< /Length ${length} >>\nstream\n${body}\nendstream\nendobj\n`;
}

/**
 * Lay the file out once, using `given` for the numbers that point elsewhere,
 * and report where everything landed. Called twice: the first pass reads its
 * own zeros and returns the true offsets, the second writes them in.
 */
function assemble(given: Layout): { text: string; measured: Layout } {
  const measured = emptyLayout();
  let text = '%PDF-1.7\n%âãÏÓ\n';
  const at = () => Buffer.byteLength(text, 'latin1');
  const put = (objectNumber: number, serialized: string) => {
    measured.objectOffsets.set(objectNumber, at());
    text += serialized;
  };

  // Part 2 — linearisation parameter dictionary (F.3.3, Table F.1). It must be
  // entirely within the first 1024 bytes, which is what fixes it here.
  put(
    2,
    '2 0 obj\n' +
      `<< /Linearized 1 /L ${pad(given.fileLength)} /H [ ${pad(given.hintOffset)} ` +
      `${pad(given.hintLength)} ] /O 4 /E ${pad(given.firstPageEnd)} /N 1 ` +
      `/T ${pad(given.mainTableFirstEntry)} >>\nendobj\n`,
  );

  // Part 3 — first-page cross-reference table and trailer (F.3.4). One
  // subsection, no free entries, and a `/Prev` pointing at the main table near
  // the end of the file. Its `/Size` is the combined count of both tables.
  measured.firstPageXrefOffset = at();
  text += `xref\n${FIRST_PAGE_OBJECTS[0]} ${FIRST_PAGE_OBJECTS.length}\n`;
  for (const objectNumber of FIRST_PAGE_OBJECTS) {
    text += `${pad(given.objectOffsets.get(objectNumber) ?? 0)} 00000 n \n`;
  }
  text +=
    `trailer << /Size ${SIZE} /Root 3 0 R /Prev ${pad(given.mainXrefOffset)} >>\n` +
    // F.3.4: the first-page trailer may end with startxref/%%EOF, and that
    // information "shall be ignored". It is written because real producers
    // write it — and because it is the second `startxref` keyword, which is
    // exactly what makes revisionCount disagree with the revision list.
    'startxref\n0\n%%EOF\n';

  // Part 4 — document catalog and document-level objects.
  put(3, '3 0 obj\n<< /Type /Catalog /Pages 1 0 R >>\nendobj\n');

  // Part 5 — primary hint stream (contents are a placeholder; see the header).
  measured.hintOffset = at();
  put(6, streamObject(6, 'placeholder for the primary hint stream (F.4)'));
  measured.hintLength = at() - measured.hintOffset;

  // Part 6 — first-page objects.
  put(
    4,
    '4 0 obj\n<< /Type /Page /Parent 1 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n',
  );
  put(5, streamObject(5, 'BT 72 720 Td (Hello linearised) Tj ET'));
  measured.firstPageEnd = at();

  // Parts 7-10 — everything else. One page means only the page tree is left.
  put(1, '1 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n');

  // Part 11 — main cross-reference table and trailer (F.3.11): a single
  // subsection beginning at object 0, whose first entry is free. Its `/Size`
  // is this table's own, as qpdf writes it; the combined count lives in the
  // first-page trailer.
  measured.mainXrefOffset = at();
  text += `xref\n0 ${MAIN_OBJECTS.length + 1}`;
  // Table F.1: `T` is the white space *preceding* the entry for object 0, not
  // the `xref` line — hence the measurement being taken here and not above.
  measured.mainTableFirstEntry = at();
  text += '\n0000000000 65535 f \n';
  for (const objectNumber of MAIN_OBJECTS) {
    text += `${pad(given.objectOffsets.get(objectNumber) ?? 0)} 00000 n \n`;
  }
  text +=
    `trailer << /Size ${MAIN_OBJECTS.length + 1} >>\n` +
    `startxref\n${pad(given.firstPageXrefOffset)}\n%%EOF\n`;

  measured.fileLength = at();
  return { text, measured };
}

/**
 * Build a one-page linearised PDF. Unsigned: what it is here to exercise is how
 * the cross-reference chain is walked, and no signature is involved in that.
 */
export function createLinearizedPdf(): Uint8Array {
  const first = assemble(emptyLayout());
  const second = assemble(first.measured);
  // Every substituted number is ten digits wide in both passes, so a length
  // change would mean an offset in the second pass is already wrong.
  if (second.text.length !== first.text.length) {
    throw new Error('linearised layout moved between passes; offsets would be wrong');
  }
  return new Uint8Array(Buffer.from(second.text, 'latin1'));
}
