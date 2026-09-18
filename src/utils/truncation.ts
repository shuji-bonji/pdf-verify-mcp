/**
 * Per-array caps for JSON responses (v0.29.0, #18).
 *
 * A JSON body is never cut by length. What bounds it is these caps: the list
 * is cut to `max` items and the cut is reported next to it as
 * `{ returned, total }`, so the body stays valid JSON and says what is
 * missing. See CHARACTER_LIMIT in constants.ts for the markdown side.
 */

import type { Truncation } from '../types.js';

/** Cut `items` to the first `max`; report the cut, or null when nothing was cut */
export function capArray<T>(items: T[], max: number): { items: T[]; truncated: Truncation | null } {
  if (items.length <= max) return { items, truncated: null };
  return { items: items.slice(0, max), truncated: { returned: max, total: items.length } };
}

/** One markdown line about a cut, or nothing */
export function truncationLine(label: string, t: Truncation | null): string[] {
  return t ? [`- ⚠ ${label}: showing ${t.returned} of ${t.total}`] : [];
}
