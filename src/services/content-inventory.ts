/**
 * Content inventory — what a document carries that acts, or that is unfinished (#20, #21).
 *
 * ISO 32000-2 §12.8.7 "Legal content attestations" (Table 264) lists exactly the counts a
 * document author would attest to because they affect its legal integrity: ECMAScript
 * actions, launch actions, URI actions, remote go-to actions, and so on. This module counts
 * the same things from the file itself, for every document, PDF/A or not — the PDF/A rule
 * subset in `pdfa-validator.ts` looks at JavaScript and prohibited actions only when a PDF/A
 * flavour is being validated, and said nothing for an ordinary PDF.
 *
 * Also counted: redaction annotations left in the file (§12.5.6.23). A `/Redact` annotation
 * marks content that is *intended* to be removed; once the redaction is applied, both the
 * annotation and the content are gone. One still present means the redaction was never
 * applied, and the content it covers is still in the file.
 *
 * 🔴 This module observes; it does not judge. The policy engine decides what a count means.
 * 🔴 `null` means "could not count", never 0. A count of 0 is an observation over every
 * object that was read; `unreadableObjects` says how many were not.
 */

import { asDict, enumerateObjects, get, nameOf } from '@normativepdf/recover';
import type { CosDict, CosObject, PdfDocument } from 'normativepdf';
import type { ContentInventory } from '../types.js';

/** Keys of Table 264 this module counts, with the `/S` names that feed each. */
const ACTION_COUNTERS: Record<string, string[]> = {
  JavaScriptActions: ['JavaScript'],
  LaunchActions: ['Launch'],
  URIActions: ['URI'],
  MovieActions: ['Movie'],
  SoundActions: ['Sound'],
  HideAnnotationActions: ['Hide'],
  GoToRemoteActions: ['GoToR', 'GoToE'],
  /** Not in Table 264, but sends data out of the document (§12.7.6.2 / §12.7.6.3). */
  SubmitFormActions: ['SubmitForm', 'ImportData'],
};

const MAX_URI_HOSTS = 32;

export async function inventoryContent(doc: PdfDocument): Promise<ContentInventory> {
  const { objects, unreadable } = await enumerateObjects(doc);

  const counts: Record<string, number> = Object.fromEntries(
    Object.keys(ACTION_COUNTERS).map((k) => [k, 0]),
  );
  let annotations = 0;
  let redactAnnotations = 0;
  let redactWithOverlay = 0;
  const uriHosts = new Set<string>();
  let javaScriptBytes = 0;

  const seen = new Set<CosDict>();

  const visitDict = (dict: CosDict): void => {
    if (seen.has(dict)) return;
    seen.add(dict);

    const s = nameOf(get(dict, 'S'));
    if (s !== null) {
      for (const [key, names] of Object.entries(ACTION_COUNTERS)) {
        if (names.includes(s)) counts[key]++;
      }
      if (s === 'JavaScript') {
        const js = get(dict, 'JS');
        if (js?.kind === 'string') javaScriptBytes += js.bytes.length;
        else if (js?.kind === 'stream') javaScriptBytes += js.raw.length;
      }
      if (s === 'URI') {
        const uri = get(dict, 'URI');
        if (uri?.kind === 'string' && uriHosts.size < MAX_URI_HOSTS) {
          const host = hostOf(new TextDecoder('latin1').decode(uri.bytes));
          if (host) uriHosts.add(host);
        }
      }
    }

    // An annotation: /Subtype naming an annotation type, on a dictionary that has a /Rect
    // (§12.5.2, Table 166 — Rect is required). /Type /Annot is optional, so it is not required here.
    const subtype = nameOf(get(dict, 'Subtype'));
    if (subtype !== null && dict.entries.has('Rect') && ANNOTATION_SUBTYPES.has(subtype)) {
      annotations++;
      if (subtype === 'Redact') {
        redactAnnotations++;
        if (dict.entries.has('OverlayText') || dict.entries.has('RO')) redactWithOverlay++;
      }
    }

    for (const value of dict.entries.values()) visitValue(value);
  };

  // Direct (nested) dictionaries and arrays are not indirect objects, so `enumerateObjects`
  // does not list them; an annotation's `/A` action is very often written inline. Descend.
  // References are not followed: the object they name is enumerated on its own.
  const visitValue = (value: CosObject): void => {
    if (value.kind === 'dict') visitDict(value);
    else if (value.kind === 'stream') visitDict(value.dict);
    else if (value.kind === 'array') for (const item of value.items) visitValue(item);
  };

  for (const { object } of objects) visitValue(object);

  const catalog = asDict(await doc.getCatalog().catch(() => null));

  return {
    actions: {
      JavaScriptActions: counts.JavaScriptActions,
      LaunchActions: counts.LaunchActions,
      URIActions: counts.URIActions,
      MovieActions: counts.MovieActions,
      SoundActions: counts.SoundActions,
      HideAnnotationActions: counts.HideAnnotationActions,
      GoToRemoteActions: counts.GoToRemoteActions,
      SubmitFormActions: counts.SubmitFormActions,
    },
    javaScriptBytes,
    uriHosts: [...uriHosts].sort(),
    openAction: catalog ? catalog.entries.has('OpenAction') : null,
    documentAdditionalActions: catalog ? catalog.entries.has('AA') : null,
    annotations,
    redactAnnotations,
    redactWithOverlay,
    optionalContent: catalog ? catalog.entries.has('OCProperties') : null,
    embeddedFiles: countEmbeddedFiles(objects.map((o) => o.object)),
    objectsRead: objects.length,
    unreadableObjects: unreadable,
  };
}

/** Table 171 (§12.5.6.1) — every standard annotation subtype. */
const ANNOTATION_SUBTYPES: ReadonlySet<string> = new Set([
  'Text',
  'Link',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Caret',
  'Stamp',
  'Ink',
  'Popup',
  'FileAttachment',
  'Sound',
  'Movie',
  'Screen',
  'Widget',
  'PrinterMark',
  'TrapNet',
  'Watermark',
  '3D',
  'Redact',
  'Projection',
  'RichMedia',
]);

/** File specification dictionaries that embed a file (`/EF`, Table 43). */
function countEmbeddedFiles(objects: CosObject[]): number {
  let n = 0;
  for (const object of objects) {
    const dict = asDict(object);
    if (!dict?.entries.has('EF')) continue;
    const looksLikeFilespec =
      nameOf(get(dict, 'Type')) === 'Filespec' || dict.entries.has('F') || dict.entries.has('UF');
    if (looksLikeFilespec) n++;
  }
  return n;
}

function hostOf(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.host || u.protocol.replace(/:$/, '');
  } catch {
    // Not an absolute URL (relative, or a scheme URL.parse rejects): keep the scheme if any.
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(uri);
    return m ? `${m[1].toLowerCase()}:` : null;
  }
}
