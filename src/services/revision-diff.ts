/**
 * Object-level diff between the incremental-update revisions of a single file
 * (Issue #8 / family gap G-B — the prerequisite of UC-10).
 *
 * This walks the cross-reference chain in the raw bytes: the last `startxref`
 * points at the newest cross-reference section, whose `/Prev` points at the
 * previous one, and so on back to the original revision. Each section declares
 * the objects that revision wrote, so comparing a section against everything
 * older than it yields "which objects this revision added / rewrote / freed".
 *
 * Deliberate limits — read the output as an observation, never as a verdict:
 *
 *   - **Incremental updates are legal** (ISO 32000-2 §7.5.6). A rewritten
 *     object is not evidence of tampering; it is evidence of *what to look at*.
 *     Nothing here moves a verdict.
 *   - The object `/Type` is read from the raw bytes of that revision, so it is
 *     revision-accurate, but objects stored inside an object stream
 *     (`/Type /ObjStm`) are reported as `inObjectStream` with no type: reading
 *     them would mean inflating the containing stream, which in an encrypted
 *     file is not decodable here.
 *   - A file whose chain cannot be walked (damaged xref, unsupported stream
 *     filter) returns `null` rather than a partial guess.
 *
 * pdf-lib is not used: it merges the whole chain into one view of the document,
 * which is exactly the information this module has to keep apart.
 *
 * **Who parses what.** Reading one cross-reference section — classic table
 * (§7.5.4), cross-reference stream (§7.5.8), hybrid XRefStm (§7.5.8.4), the
 * PNG/TIFF predictors and the Flate decoding underneath — is normativepdf's
 * job (`readXrefSectionAt`). That library reads the clause and is strict: an
 * unreadable section is an error, not a shorter answer.
 *
 * What stays here is the **recovery policy**, which the library deliberately
 * does not own (see its `readXrefSectionAt` doc comment). This module is a
 * forensic tool pointed at files that may be damaged or hostile, so it must
 * describe what it can instead of refusing:
 *
 *   - the newest `startxref` may be a lie — older entry points are tried, and
 *     the fact is reported (`newestSectionUnreadable`);
 *   - `MAX_REVISIONS` and cycle detection cap a malformed `/Prev` chain;
 *   - a linearised file (Annex F) and a full "Save As" both make the naive
 *     walk lie about what changed — see `walkChain` and
 *     `MAX_CHANGES_PER_REVISION`.
 *
 * Offsets: §7.5.2 measures every offset from the PERCENT SIGN of `%PDF-`, so
 * a file with bytes before its header has `origin > 0`. normativepdf works in
 * that origin-relative space; every offset this module reports or peeks at is
 * absolute (`origin + offset`), because that is what a reviewer opening the
 * file in an editor needs.
 */

import { dictGet, readXrefSectionAt, type XrefEntry, type XrefSection } from 'normativepdf';
import type {
  DocMdpChangeClass,
  RevisionObjectChange,
  RevisionSummary,
  XrefKind,
} from '../types.js';
import { logger } from '../utils/logger.js';

const CONTEXT = 'revision-diff';

/** How far past an object's offset the type peek is willing to read. */
const OBJECT_PEEK_BYTES = 4096;
/** Guard against a malformed `/Prev` cycle. */
const MAX_REVISIONS = 200;
/** How far into the file the linearisation dictionary is looked for. */
const LINEARIZED_HEADER_SCAN = 1024;
/**
 * Upper bound on the object changes listed per revision. A full rewrite (a
 * "Save As" rather than an incremental update) can touch six figures of
 * objects; listing them all would bury the answer and blow the response size.
 * Measured: at 200 a three-revision full save overran the 25,000-character
 * response limit and was cut mid-structure. `changeCount` keeps the true total.
 */
const MAX_CHANGES_PER_REVISION = 25;
/** How many candidates per listed change may be typed before ranking. */
const PEEK_BUDGET_FACTOR = 8;

const LATIN1 = new TextDecoder('latin1');

/**
 * One revision as this module needs it: a section normativepdf parsed, with
 * its offset already resolved to an absolute file position and its entry map
 * made mutable so the linearisation fix-up can fold two sections into one.
 */
interface Revision {
  /** Absolute byte offset of the cross-reference section (`origin + offset`) */
  offset: number;
  kind: XrefKind;
  entries: Map<number, XrefEntry>;
  /** Object number of the cross-reference stream itself, when it is one */
  selfObjectNumber: number | null;
}

/**
 * §7.5.8.3 — an entry whose type is not 0/1/2 "shall be interpreted as a
 * reference to the null object". From a reader's point of view that is
 * indistinguishable from a free entry, so both answer "this object number
 * resolves to nothing here". Keeping unknown entries (rather than dropping
 * them, as the hand-rolled parser did) matters because a newer section's
 * unknown entry must still shadow an older definition.
 */
function readsAsNull(entry: XrefEntry): boolean {
  return entry.type === 'free' || entry.type === 'unknown';
}

/** Generation number, or 0 where the format defines it implicitly (§7.5.7). */
function generationOf(entry: XrefEntry): number {
  return entry.type === 'in-use' || entry.type === 'free' ? entry.generation : 0;
}

/* ------------------------------------------------------------------ *
 * byte helpers
 * ------------------------------------------------------------------ */

function isWhitespace(byte: number): boolean {
  return (
    byte === 0x20 ||
    byte === 0x0a ||
    byte === 0x0d ||
    byte === 0x09 ||
    byte === 0x0c ||
    byte === 0x00
  );
}

function isDelimiter(byte: number): boolean {
  return (
    byte === 0x28 || // (
    byte === 0x29 || // )
    byte === 0x3c || // <
    byte === 0x3e || // >
    byte === 0x5b || // [
    byte === 0x5d || // ]
    byte === 0x7b || // {
    byte === 0x7d || // }
    byte === 0x2f || // /
    byte === 0x25 // %
  );
}

/** Zero-copy Buffer view, so keyword scans use the native search. */
function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function indexOfBytes(hay: Uint8Array, needle: string, from: number): number {
  return asBuffer(hay).indexOf(needle, Math.max(0, from), 'latin1');
}

function skipWhitespace(bytes: Uint8Array, index: number): number {
  let i = index;
  while (i < bytes.length) {
    if (isWhitespace(bytes[i])) {
      i += 1;
      continue;
    }
    // A comment runs to the end of the line and counts as whitespace.
    if (bytes[i] === 0x25) {
      while (i < bytes.length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i += 1;
      continue;
    }
    break;
  }
  return i;
}

/** Read the next whitespace/delimiter-terminated token. */
function readToken(bytes: Uint8Array, index: number): { token: string; next: number } | null {
  const start = skipWhitespace(bytes, index);
  if (start >= bytes.length) return null;
  let end = start;
  if (isDelimiter(bytes[end])) {
    // Names and dictionary markers are handled by their own readers.
    return { token: String.fromCharCode(bytes[end]), next: end + 1 };
  }
  while (end < bytes.length && !isWhitespace(bytes[end]) && !isDelimiter(bytes[end])) end += 1;
  return { token: LATIN1.decode(bytes.subarray(start, end)), next: end };
}

/* ------------------------------------------------------------------ *
 * cross-reference sections — read by normativepdf, recovered here
 * ------------------------------------------------------------------ */

/**
 * §7.5.2 — "byte offsets shall be calculated from the PERCENT SIGN" of the
 * `%PDF-` header, which need not be at byte 0. A file with no header at all is
 * not dismissed here (that is the validator's verdict, not this module's): the
 * origin falls back to 0 so the chain can still be described.
 */
function findOrigin(bytes: Uint8Array): number {
  return Math.max(0, indexOfBytes(bytes, '%PDF-', 0));
}

/**
 * Read the single cross-reference section addressed at `offset`, or `null` when
 * normativepdf cannot read it. The library throws by design — an unreadable
 * section is an error there, because merging a partial chain would silently
 * lose objects. Here it is a fact to report, so the throw is caught and the
 * caller turns it into `truncated` / `newestSectionUnreadable`.
 */
interface SectionRead {
  revision: Revision;
  prev: PrevLink;
}

async function readSection(
  bytes: Uint8Array,
  origin: number,
  offset: number,
): Promise<SectionRead | null> {
  if (offset <= 0 || origin + offset >= bytes.length) return null;
  let section: XrefSection;
  try {
    section = await readXrefSectionAt(bytes, offset, origin);
  } catch (error) {
    logger.debug(CONTEXT, `cross-reference section at ${offset} is unreadable: ${String(error)}`);
    return null;
  }
  return {
    revision: {
      offset: origin + section.offset,
      kind: section.kind,
      entries: new Map(section.entries),
      selfObjectNumber: section.selfObjectNumber ?? null,
    },
    prev: readPrev(section),
  };
}

/**
 * The `/Prev` of a section's trailer (§7.5.5 Table 15; Table 17 for streams).
 *
 * Three outcomes, deliberately distinguished: `end` (no entry — the chain is
 * complete), an offset to follow, or `malformed`. normativepdf rejects a
 * non-integer `/Prev` outright; this module reports it as a chain that could
 * not be followed to the end, which is what the DocMDP assessment has to know.
 */
type PrevLink = { kind: 'end' } | { kind: 'malformed' } | { kind: 'at'; offset: number };

function readPrev(section: XrefSection): PrevLink {
  const prev = dictGet(section.trailer, 'Prev');
  if (prev === undefined) return { kind: 'end' };
  if (prev.kind === 'integer' && prev.value > 0) return { kind: 'at', offset: prev.value };
  return { kind: 'malformed' };
}

/** Every `startxref` value in the file, in the order they appear. */
function collectStartxrefTargets(bytes: Uint8Array): number[] {
  const targets: number[] = [];
  let from = 0;
  for (;;) {
    const at = indexOfBytes(bytes, 'startxref', from);
    if (at < 0) break;
    const token = readToken(bytes, at + 'startxref'.length);
    if (token) {
      const value = Number.parseInt(token.token, 10);
      if (!Number.isNaN(value)) targets.push(value);
    }
    from = at + 'startxref'.length;
  }
  return targets;
}

/**
 * Walk `startxref` → `/Prev` → … and return the revisions oldest first.
 *
 * Reading each section is normativepdf's job; everything below is the recovery
 * policy that library deliberately leaves to its consumer.
 */
async function walkChain(
  bytes: Uint8Array,
  origin: number,
): Promise<{
  sections: Revision[];
  truncated: boolean;
  newestSectionUnreadable: boolean;
  linearized: boolean;
} | null> {
  const targets = collectStartxrefTargets(bytes);
  if (targets.length === 0) return null;

  // Normally the last `startxref` is the entry point. When it does not point
  // at a parseable section the file still has to be described rather than
  // dismissed, so an older entry point is tried — and the fact is reported,
  // because it means the trailing bytes are NOT represented in the diff.
  // The probe's result is kept: re-reading the entry section would decode the
  // same (possibly Flate + predictor) cross-reference stream twice.
  let entry: number | null = null;
  let entrySection: SectionRead | null = null;
  let newestSectionUnreadable = false;
  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const probe = targets[i] > 0 ? await readSection(bytes, origin, targets[i]) : null;
    if (probe) {
      entry = targets[i];
      entrySection = probe;
      newestSectionUnreadable = i !== targets.length - 1;
      break;
    }
  }
  if (entry === null) return null;
  let next: number | null = entry;
  let pending: SectionRead | null = entrySection;

  const sections: Revision[] = [];
  const visited = new Set<number>();
  let truncated = false;
  while (next !== null && next > 0) {
    if (visited.has(next)) {
      truncated = true;
      break;
    }
    visited.add(next);
    const read: SectionRead | null = pending ?? (await readSection(bytes, origin, next));
    pending = null;
    if (!read) {
      truncated = true;
      break;
    }
    sections.push(read.revision);
    if (sections.length >= MAX_REVISIONS) {
      truncated = true;
      break;
    }
    if (read.prev.kind === 'end') {
      next = null;
    } else if (read.prev.kind === 'at') {
      next = read.prev.offset;
    } else {
      // A `/Prev` that is present but not a direct positive integer means the
      // chain does not end here — it just cannot be followed. Reporting that as
      // a clean end would let `assessDocMdp` treat an unwalkable tail as "no
      // older revisions", which is the mistake this whole module exists to
      // avoid. [[revision-diff-lies-linearized-and-full-save]]
      truncated = true;
      next = null;
    }
  }
  if (sections.length === 0) return null;
  const ordered = sections.reverse();

  // A linearised file (ISO 32000-2 Annex F) carries TWO cross-reference
  // sections for a single save: the first-page section near the top of the
  // file, whose /Prev points at the main section at the bottom. Walking the
  // chain naively turns one save into two "revisions" and reports every object
  // as added. The giveaway is that the newer section sits at a LOWER offset.
  const linearized =
    ordered.length >= 2 &&
    ordered[ordered.length - 1].offset < ordered[ordered.length - 2].offset &&
    /\/Linearized\b/.test(LATIN1.decode(bytes.subarray(origin, origin + LINEARIZED_HEADER_SCAN)));
  if (linearized) {
    const firstPage = ordered.pop();
    const main = ordered[ordered.length - 1];
    if (firstPage && main) {
      for (const [key, entry] of firstPage.entries) main.entries.set(key, entry);
    }
  }

  return { sections: ordered, truncated, newestSectionUnreadable, linearized };
}

/* ------------------------------------------------------------------ *
 * object typing
 * ------------------------------------------------------------------ */

interface PeekedObject {
  type: string | null;
  subtype: string | null;
  /** Top-level keys seen in the object's dictionary */
  keys: string[];
}

/** Read a name token (`/Foo`) at `index`, if one starts there. */
function readName(bytes: Uint8Array, index: number): { name: string; next: number } | null {
  let i = skipWhitespace(bytes, index);
  if (bytes[i] !== 0x2f) return null;
  i += 1;
  const start = i;
  while (i < bytes.length && !isWhitespace(bytes[i]) && !isDelimiter(bytes[i])) i += 1;
  return { name: LATIN1.decode(bytes.subarray(start, i)), next: i };
}

/**
 * Read `/Type`, `/Subtype` and the top-level keys of the object written at
 * `offset`, without decoding any stream or string. Dictionary keys and name
 * values are never encrypted (ISO 32000-1 §7.6.2 encrypts strings and streams
 * only), so this also works on an encrypted file.
 */
function peekObject(bytes: Uint8Array, offset: number): PeekedObject | null {
  if (offset <= 0 || offset >= bytes.length) return null;
  const window = bytes.subarray(offset, Math.min(bytes.length, offset + OBJECT_PEEK_BYTES));
  const objNum = readToken(window, 0);
  const gen = objNum ? readToken(window, objNum.next) : null;
  const objKeyword = gen ? readToken(window, gen.next) : null;
  if (!objNum || !gen || !objKeyword || objKeyword.token !== 'obj') return null;

  // The dictionary is scanned from `<<` to the end of the window rather than
  // to a matching `>>`: a signature dictionary's /Contents is a hex string of
  // several kilobytes, so requiring the closing marker inside the window would
  // lose the type of exactly the objects that matter most here.
  const dictStart = skipWhitespace(window, objKeyword.next);
  if (window[dictStart] !== 0x3c || window[dictStart + 1] !== 0x3c) {
    return { type: null, subtype: null, keys: [] };
  }
  const extent = { start: dictStart, end: window.length };

  const keys: string[] = [];
  let type: string | null = null;
  let subtype: string | null = null;
  let depth = 0;
  let i = extent.start;
  while (i < extent.end) {
    if (depth === 0 && i > extent.start) break; // the object's dictionary closed
    const b = window[i];
    if (b === 0x3c && window[i + 1] === 0x3c) {
      depth += 1;
      i += 2;
      continue;
    }
    if (b === 0x3e && window[i + 1] === 0x3e) {
      depth -= 1;
      i += 2;
      continue;
    }
    if (b === 0x28) {
      let nest = 1;
      i += 1;
      while (i < extent.end && nest > 0) {
        if (window[i] === 0x5c) i += 2;
        else if (window[i] === 0x28) {
          nest += 1;
          i += 1;
        } else if (window[i] === 0x29) {
          nest -= 1;
          i += 1;
        } else i += 1;
      }
      continue;
    }
    if (b === 0x3c) {
      while (i < extent.end && window[i] !== 0x3e) i += 1;
      i += 1;
      continue;
    }
    if (b === 0x2f && depth === 1) {
      const key = readName(window, i);
      if (!key) {
        i += 1;
        continue;
      }
      keys.push(key.name);
      const value = readName(window, key.next);
      if (value && key.name === 'Type') type = value.name;
      if (value && key.name === 'Subtype') subtype = value.name;
      i = key.next;
      continue;
    }
    i += 1;
  }
  return { type, subtype, keys };
}

/** Plain-language role, so a report does not have to teach PDF object types. */
function describeRole(peeked: PeekedObject | null): string | null {
  if (!peeked) return null;
  const { type, subtype, keys } = peeked;
  if (type === 'Annot') {
    if (subtype === 'Widget') {
      return keys.includes('FT') || keys.includes('T')
        ? 'form field widget (interactive form value or appearance)'
        : 'form field widget';
    }
    return `annotation${subtype ? ` (${subtype})` : ''}`;
  }
  if (type === 'Sig') return 'signature dictionary';
  if (type === 'DocTimeStamp') return 'document timestamp';
  if (type === 'Page') return 'page object';
  if (type === 'Pages') return 'page tree node';
  if (type === 'Catalog') return 'document catalog';
  if (type === 'XRef') return 'cross-reference stream';
  if (type === 'ObjStm') return 'object stream (container)';
  if (type === 'Metadata') return 'metadata stream (XMP)';
  if (type === 'Font') return 'font';
  if (type === 'ExtGState') return 'graphics state';
  if (type === 'XObject') return `external object${subtype ? ` (${subtype})` : ''}`;
  if (type === 'StructTreeRoot' || type === 'StructElem') return 'logical structure';
  if (type === 'OCG' || type === 'OCMD') return 'optional content';
  if (type !== null) return type;
  if (keys.includes('Fields') && (keys.includes('SigFlags') || keys.includes('DA'))) {
    return 'interactive form dictionary (AcroForm)';
  }
  if (keys.includes('Kids') && keys.includes('Fields')) return 'form field tree';
  if (keys.includes('Certs') || keys.includes('OCSPs') || keys.includes('CRLs')) {
    return 'DSS / validation-related data';
  }
  if (keys.includes('FT')) return 'form field';
  if (keys.includes('Length')) return 'stream (content, image or embedded data)';
  return null;
}

/**
 * Which kind of change this object represents, for the DocMDP assessment
 * (ISO 32000-2 Table 257). See `DocMdpChangeClass` for what each value means
 * and why `housekeeping` exists.
 *
 * ⚠️ Returns `unknown` whenever the object's kind could not be read — including
 * objects inside an object stream, whose bytes are not inflated here. The
 * caller turns that into `indeterminate`, never into a pass.
 */
function classifyChange(peeked: PeekedObject | null, bookkeeping: boolean): DocMdpChangeClass {
  if (bookkeeping) return 'bookkeeping';
  if (!peeked) return 'unknown';
  const { type, subtype, keys } = peeked;

  if (type === 'Annot') return subtype === 'Widget' ? 'form-fill' : 'annotation';
  if (type === 'Sig' || type === 'DocTimeStamp') return 'signature';
  // The page itself is dragged along by a lawful annotation or form-field
  // change (its /Annots array gains an entry). Its *content* is a different
  // object (the stream /Contents points at), which classifies as `content`.
  if (type === 'Page' || type === 'Pages' || type === 'Catalog') return 'housekeeping';
  if (type === 'Metadata') return 'housekeeping';
  if (
    type === 'StructTreeRoot' ||
    type === 'StructElem' ||
    type === 'Font' ||
    type === 'XObject' ||
    type === 'ExtGState' ||
    type === 'OCG' ||
    type === 'OCMD'
  ) {
    return 'content';
  }
  if (type !== null) return 'content';

  // Untyped dictionaries — identified by the keys they carry.
  if (keys.includes('Fields') && (keys.includes('SigFlags') || keys.includes('DA')))
    return 'form-fill';
  if (keys.includes('Kids') && keys.includes('Fields')) return 'form-fill';
  if (keys.includes('FT')) return 'form-fill';
  if (keys.includes('Certs') || keys.includes('OCSPs') || keys.includes('CRLs')) return 'signature';
  // The trailer's /Info dictionary carries no /Type, which is why it used to be
  // reported as "type not determined". Every writer bumps its /ModDate and
  // /Producer alongside a permitted change, so it is housekeeping — but
  // identify it by its own keys rather than assuming any untyped dictionary is.
  if (keys.includes('Producer') || keys.includes('ModDate') || keys.includes('CreationDate')) {
    return 'housekeeping';
  }
  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * public entry point
 * ------------------------------------------------------------------ */

export interface RevisionDiffInput {
  bytes: Uint8Array;
  /**
   * End offset (`ByteRange[2] + ByteRange[3]`) of each signature, with the
   * field name when it is readable. Used to say which revisions were appended
   * after a given signature was made — not to judge them.
   */
  signedRanges: { fieldName: string | null; endOffset: number }[];
}

export interface RevisionDiffResult {
  revisions: RevisionSummary[];
  /** true when the chain could not be followed all the way back */
  truncated: boolean;
  /**
   * true when the file's last `startxref` did not point at a parseable
   * cross-reference section, so the chain had to be entered from an older one.
   * The trailing bytes are then NOT represented by any revision listed here.
   */
  newestSectionUnreadable: boolean;
  /**
   * true when the file is linearised (ISO 32000-2 Annex F): its first-page and
   * main cross-reference sections were merged back into the one revision they
   * belong to, instead of being reported as an incremental update.
   */
  linearized: boolean;
}

/**
 * Build the per-revision object diff. Returns `null` when the cross-reference
 * chain cannot be walked — a partial answer here would be indistinguishable
 * from "nothing changed", which is the one thing this must never imply.
 */
export async function diffRevisions(input: RevisionDiffInput): Promise<RevisionDiffResult | null> {
  const { bytes, signedRanges } = input;
  const origin = findOrigin(bytes);
  const walked = await walkChain(bytes, origin);
  if (!walked) {
    logger.debug(CONTEXT, 'cross-reference chain could not be walked');
    return null;
  }

  const seen = new Map<number, XrefEntry>();
  const revisions: RevisionSummary[] = [];

  walked.sections.forEach((section, index) => {
    const eof = indexOfBytes(bytes, '%%EOF', section.offset);
    const endOffset = eof < 0 ? null : eof + '%%EOF'.length;
    /** Changed objects before typing: a full save can hold six figures of them. */
    const raw: {
      objectNumber: number;
      entry: XrefEntry;
      change: RevisionObjectChange['change'];
      selfXref: boolean;
    }[] = [];

    if (index > 0) {
      const objectNumbers = [...section.entries.keys()].sort((a, b) => a - b);
      for (const objectNumber of objectNumbers) {
        if (objectNumber === 0) continue; // head of the free list, always present
        const entry = section.entries.get(objectNumber);
        if (!entry) continue;
        const previous = seen.get(objectNumber);

        let change: RevisionObjectChange['change'];
        if (readsAsNull(entry)) {
          if (!previous || readsAsNull(previous)) continue; // freed twice, or never used
          change = 'freed';
        } else if (!previous || readsAsNull(previous)) {
          change = 'added';
        } else if (
          previous.type === 'in-use' &&
          entry.type === 'in-use' &&
          previous.offset === entry.offset
        ) {
          continue; // re-declared at the same offset: not a rewrite
        } else {
          change = 'modified';
        }

        raw.push({
          objectNumber,
          entry,
          change,
          // A revision's own cross-reference stream is bookkeeping, not content.
          selfXref: section.selfObjectNumber === objectNumber,
        });
      }
    }

    for (const [objectNumber, entry] of section.entries) seen.set(objectNumber, entry);

    // Typing means reading the object's raw bytes, so it is done for a bounded
    // candidate set rather than for every object of a full save. Candidates are
    // taken in object-number order with the section's own cross-reference
    // stream pushed to the back, since that one is always bookkeeping.
    const candidates = raw
      .sort((a, b) => Number(a.selfXref) - Number(b.selfXref) || a.objectNumber - b.objectNumber)
      .slice(0, MAX_CHANGES_PER_REVISION * PEEK_BUDGET_FACTOR);
    const typed = candidates.map(({ objectNumber, entry, change, selfXref }) => {
      // §7.5.2 — the entry's offset is measured from the header, not byte 0.
      const peeked = entry.type === 'in-use' ? peekObject(bytes, origin + entry.offset) : null;
      const bookkeeping = selfXref || peeked?.type === 'XRef' || peeked?.type === 'ObjStm';
      const item: RevisionObjectChange = {
        objectNumber,
        generation: generationOf(entry),
        change,
        type: peeked?.type ?? null,
        subtype: peeked?.subtype ?? null,
        role: describeRole(peeked),
        changeClass: classifyChange(peeked, bookkeeping),
        bookkeeping,
        inObjectStream: entry.type === 'compressed',
      };
      return item;
    });
    // When the list has to be cut, keep the objects a reviewer can act on.
    // Rank 0 — the object's type could be read, so the entry says something.
    // Rank 1 — inside an object stream: real, but nothing beyond its number.
    // Rank 2 — cross-reference / object streams, rewritten by every save.
    const rank = (change: RevisionObjectChange): number => {
      if (change.bookkeeping) return 2;
      if (change.type === null && change.role === null) return 1;
      return 0;
    };
    const listed = typed
      .sort((a, b) => rank(a) - rank(b) || a.objectNumber - b.objectNumber)
      .slice(0, MAX_CHANGES_PER_REVISION);

    revisions.push({
      index: index + 1,
      xrefOffset: section.offset,
      endOffset,
      xrefKind: section.kind,
      objectCount: section.entries.size,
      changeCount: index === 0 ? 0 : raw.length,
      changesTruncated: listed.length < raw.length,
      changes: index === 0 ? null : listed,
      // The cross-reference section of a revision sits at its end, so a
      // section starting past a signed range means the revision was appended
      // after that signature was made.
      afterSignatures: signedRanges
        .filter((range) => range.endOffset <= section.offset)
        .map((range) => range.fieldName),
    });
  });

  return {
    revisions,
    truncated: walked.truncated,
    newestSectionUnreadable: walked.newestSectionUnreadable,
    linearized: walked.linearized,
  };
}
