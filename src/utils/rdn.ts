/**
 * X.500 Relative Distinguished Name formatting.
 *
 * Two renderings with different purposes:
 * - `formatRdn`    — human/LLM-readable display (`CN=..., O=...`)
 * - `canonicalName` — raw-OID matching key (`2.5.4.3=...`), used to compare
 *   subject/issuer names. Never show it to users and never mix the two:
 *   they use different separators and attribute names by design.
 */

import type * as pkijs from 'pkijs';

const RDN_OID_NAMES: Readonly<Record<string, string>> = {
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '1.2.840.113549.1.9.1': 'E',
};

/** Format an RDN sequence, mapping well-known attribute OIDs to short names */
export function formatRdn(rdn: pkijs.RelativeDistinguishedNames): string {
  return rdn.typesAndValues
    .map((tv) => {
      const name = RDN_OID_NAMES[tv.type] ?? tv.type;
      return `${name}=${tv.value.valueBlock.value}`;
    })
    .join(', ');
}

/**
 * Canonical matching key for an RDN sequence (raw OIDs, `,` separated).
 *
 * String-based comparison is a pragmatic approximation of RFC 5280 name
 * matching: it assumes both names decode attribute values identically and
 * appear in the same order, which holds for the same CA re-encoding its own
 * name (the case we compare). A future improvement could compare canonical
 * DER encodings instead.
 */
export function canonicalName(rdn: pkijs.RelativeDistinguishedNames): string {
  return rdn.typesAndValues.map((tv) => `${tv.type}=${tv.value.valueBlock.value}`).join(',');
}
