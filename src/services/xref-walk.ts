/**
 * 相互参照チェーンの歩きと、その**回復方針**。
 *
 * normativepdf は §7.5 を条文どおりに読み、回復方針を持たない —— `readXrefSectionAt` の
 * doc コメントが「自分で歩く消費者のために公開している。第 1 消費者は pdf-verify-mcp の
 * revision diff」と名指ししているとおり、ここがその方針の置き場である。
 *
 * **なぜ 1 か所なのか**（2026-08-28・docs/handoff/pdflib-removal.md §11.4）:
 * この方針は revision diff だけのものではない。文書を開く入口（`pdf-parser.ts`）も
 * 同じ判断を要る —— コーパス 2,947 検体のうち 17 件は、入口の節や `startxref` が
 * 条文に反していて `parsePdf` が受け取らない。方針が 2 か所にあると、
 * 「この文書をどこまで読んだか」の答えがツールによって割れる。
 *
 * 方針は 4 つ:
 *   1. 最後の `startxref` が読めなければ、古い入口を順に試す（試したことは申告する）
 *   2. `/Prev` が正の整数でなければ、そこで打ち切る —— 「きれいに終わった」とは言わない
 *   3. 巡回と `MAX_REVISIONS` で止める
 *   4. 線形化（Annex F）の 2 節は 1 リビジョンに畳む
 *
 * ここに判定は書かない。どこまで読めたかを返すだけで、それをどう読むかは呼び出し側が決める。
 */

import {
  type CosDict,
  dictGet,
  readXrefSectionAt,
  type XrefEntry,
  type XrefSection,
} from 'normativepdf';
import type { XrefKind } from '../types.js';
import { logger } from '../utils/logger.js';

const CONTEXT = 'xref-walk';

/** Guard against a malformed `/Prev` cycle. */
const MAX_REVISIONS = 200;
/** How far into the file the linearisation dictionary is looked for. */
const LINEARIZED_HEADER_SCAN = 1024;

export const LATIN1 = new TextDecoder('latin1');

/**
 * 歩いて読めた 1 つの相互参照節。offset は絶対位置に直してあり、entries は
 * 線形化の畳み込みのために可変にしてある。`trailer` は文書を組み立てる側が要る。
 */
export interface WalkedSection {
  /** Absolute byte offset of the cross-reference section (`origin + offset`) */
  offset: number;
  kind: XrefKind;
  entries: Map<number, XrefEntry>;
  /** Object number of the cross-reference stream itself, when it is one */
  selfObjectNumber: number | null;
  /** Trailer dictionary of this section (§7.5.5 Table 15; Table 17 for streams) */
  trailer: CosDict;
}

/** 歩いた結果。`sections` は古い順。 */
export interface WalkedChain {
  /** §7.5.2 の原点（`%PDF-` の位置）。節の offset は絶対、エントリの offset は原点相対 */
  origin: number;
  sections: WalkedSection[];
  /** チェーンを最後まで辿れなかった（巡回・上限・辿れない `/Prev`） */
  truncated: boolean;
  /** 最後の `startxref` が読めず、古い入口から入った = 末尾のバイトはどの節にも代表されていない */
  newestSectionUnreadable: boolean;
  /** 線形化（Annex F）の 2 節を 1 リビジョンに畳んだ */
  linearized: boolean;
}

/* ------------------------------------------------------------------ *
 * byte helpers
 * ------------------------------------------------------------------ */

export function isWhitespace(byte: number): boolean {
  return (
    byte === 0x20 ||
    byte === 0x0a ||
    byte === 0x0d ||
    byte === 0x09 ||
    byte === 0x0c ||
    byte === 0x00
  );
}

export function isDelimiter(byte: number): boolean {
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

export function indexOfBytes(hay: Uint8Array, needle: string, from: number): number {
  return asBuffer(hay).indexOf(needle, Math.max(0, from), 'latin1');
}

export function skipWhitespace(bytes: Uint8Array, index: number): number {
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
export function readToken(
  bytes: Uint8Array,
  index: number,
): { token: string; next: number } | null {
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
export function findOrigin(bytes: Uint8Array): number {
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
  revision: WalkedSection;
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
      trailer: section.trailer,
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
export async function walkXrefChain(
  bytes: Uint8Array,
  origin: number = findOrigin(bytes),
): Promise<WalkedChain | null> {
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

  const sections: WalkedSection[] = [];
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

  return { origin, sections: ordered, truncated, newestSectionUnreadable, linearized };
}
