/**
 * X.500 Relative Distinguished Name formatting.
 *
 * Renders a pkijs RDN sequence as a human/LLM-readable string
 * (`CN=..., O=...`) instead of raw attribute OIDs (`2.5.4.3=...`).
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
