# pdf-verify-mcp

[![CI](https://github.com/shuji-bonji/pdf-verify-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/shuji-bonji/pdf-verify-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@shuji-bonji/pdf-verify-mcp.svg)](https://www.npmjs.com/package/@shuji-bonji/pdf-verify-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

[日本語](./README.ja.md)

MCP server for PDF **authenticity and conformance verification** — cryptographic digital signature verification, tamper detection, PAdES baseline level detection, and PDF/A (ISO 19005) / PDF/UA (ISO 14289) validation.

Part of the PDF family alongside [pdf-reader-mcp](https://github.com/shuji-bonji/pdf-reader-mcp) (structure analysis) and [pdf-spec-mcp](https://github.com/shuji-bonji/pdf-spec-mcp) (specification reference). Where `pdf-reader-mcp` tells you *what is in* a PDF, `pdf-verify-mcp` tells you *whether it is genuine*.

## Tools

| Tool | Purpose |
|------|---------|
| `verify_signatures` | Cryptographic verification, trust chain evaluation against trust anchors, revocation checking (embedded OCSP/CRL or online), RFC 3161 timestamp verification |
| `verify_integrity` | Tamper detection: incremental updates, changes after signing, **DocMDP certification violations assessed per P value** (below), and an object-level diff of the revision chain (which objects each update added, rewrote or freed). Incremental updates are legal, so the diff says what to review — no verdict rests on it. Where those objects sit on the page is [pdf-reader-mcp](https://github.com/shuji-bonji/pdf-reader-mcp) `locate_objects` |
| `detect_pades_level` | PAdES baseline level (B-B / B-T / B-LT / B-LTA) with content-validated LTV data |
| `identify_conformance` | Declared PDF/A / PDF/UA conformance from XMP metadata |
| `validate_conformance` | PDF/A (ISO 19005) and PDF/UA (ISO 14289) validation: veraPDF when installed, built-in rule subset otherwise |
| `validate_clauses` | Constraints mapped from ISO 32000-1/-2 clauses — the specification body itself, which the PDF/A and PDF/UA profiles do not cover |
| `evaluate_policy` | Deterministic 4-value trust verdict (trust_and_use / use_with_caution / human_review_required / reject) from a fixed rule table over the verification facts, with domain profiles (contract, financial, legal, medical, government). The judge is code; the narrative is the LLM |

## Verdicts

| Verdict | Meaning |
|---------|---------|
| `valid` | ByteRange digest matches and the CMS signature is cryptographically valid |
| `invalid` | Digest mismatch or signature verification failure — possible tampering |
| `indeterminate` | Unsupported format or verification could not complete |

## DocMDP certification permissions (v0.14)

A certification signature's `P` value states **which kinds of change are allowed**
(ISO 32000-2 **Table 257**). `verify_integrity` classifies the changes made after signing at the
object level and compares them against what that `P` permits.

| P | Permitted changes | Is adding an annotation a violation? |
|---|---|---|
| 1 | none (DSS / document-timestamp incremental updates are the §12.8.2.2 exception) | **yes** |
| 2 | filling in forms, instantiating page templates, signing | **yes** — annotations start at 3 |
| 3 | as for 2, plus annotation creation, deletion and modification | no |

Objects that a permitted change **necessarily drags along** — the page whose `/Annots` grew, the
catalog, `/Info`, the XMP stream — are classified as `housekeeping` and are not counted as
violations. Counting them would make *every* certified document violate, since a lawful P=3
annotation addition moves all four.

### `violationAssessment` is three-valued

| Value | Meaning |
|---|---|
| `permitted` | every change after signing is of a kind `P` allows |
| `violated` | at least one change is outside it |
| `indeterminate` | **it could not be determined** (the xref chain could not be walked, or a changed object's kind could not be read) |

> ⚠️ **`indeterminate` is not a pass.** This server disproves, and "could not be disproved" is a
> different statement from "is fine" — the same discipline as `validate_clauses` returning
> `needs_external_fact` rather than defaulting a check into a pass.
>
> `violatedByLaterChanges` (boolean) is kept for compatibility and **collapses `indeterminate` to
> `false`**. Read `violationAssessment` wherever "could not tell" must not be mistaken for
> "fine". `evaluate_policy` raises `indeterminate` to `human_review_required` as well.

A bare stream with no `/Type` is treated as *not determined* rather than as `content`: the same
bytes could be a form field's appearance stream (which P=2 permits) or a page's content stream
(which no P permits).

## Trust & revocation (v0.2)

Pass `trust_anchors` (PEM/DER file paths) or set the `PDF_VERIFY_TRUST_ANCHORS` env var (a directory of certificates) to evaluate the signer's chain: results are `trusted` / `untrusted` / `not_evaluated` with the certificate path, validated at signing time.

`check_revocation` controls revocation checking: `embedded` (default — OCSP/CRL data inside the PDF's DSS or the CMS payload), `online` (additionally query OCSP responders and CRL distribution points over HTTP), or `none`. A revoked signer certificate forces verdict `invalid`. In online mode, missing issuer certificates are fetched via AIA caIssuers to complete the chain (v0.4). When anchors are provided, TSA certificate chains of RFC 3161 timestamps are evaluated too (`tsaTrust`).

> Without trust anchors, `trust` stays `not_evaluated` and a `valid` verdict asserts cryptographic integrity, not signer identity.

Encrypted PDFs are decrypted automatically when permission-encrypted (empty user password); pass `password` for reader-password PDFs. Supported: RC4 (R2–R4), AES-128, AES-256 (R6). Decryption recovers string metadata (field name, /M, /Reason, /Location) and XMP — a signature's `/Contents` is exempt from encryption, so verification never depends on it.

Supported SubFilters: `ETSI.CAdES.detached` (PAdES), `adbe.pkcs7.detached`, `ETSI.RFC3161` (document timestamps). RFC 3161 signature timestamps are fully verified (imprint + TSA signature). Legacy MD5/SHA-1 signatures are verified via node:crypto and flagged as weak.

## PDF/A validation (v0.3)

`validate_conformance` uses a hybrid engine. With veraPDF installed (`PDF_VERIFY_VERAPDF` env var or on PATH) validation is delegated for authoritative results. Otherwise a built-in subset of ~15 high-value ISO 19005 rules runs natively (encryption, trailer /ID, LZW, font embedding, JavaScript/prohibited actions, OutputIntent, transparency for A-1, XFA, and more), each reported with its clause reference.

Native results are honest about their limits: violations mean definitively non-compliant; all-passed means "no violations in the checked subset" — never certification.

PDF/A-4 (`pdfa-4`, `pdfa-4e`, `pdfa-4f`) is accepted. Note that **PDF/A-4 has no conformance level** — there is no `pdfa-4b`; `e` and `f` are variants. The native rules were written from ISO 19005-1/-2 and have not been checked against ISO 19005-4, so a PDF/A-4 report says outright that the native verdict ranks below veraPDF. Validate part 4 with veraPDF.

## ISO 32000 clause constraints (v0.9)

`validate_clauses` covers different ground: the **body of the PDF specification**, not the PDF/A or PDF/UA profiles. A file can be judged COMPLIANT by veraPDF and still violate ISO 32000 — embedding a CFF font program under `/FontFile2` (Table 124) is a real example that surfaced only as a viewer warning.

The mapping from clauses to structural conditions, and its evaluation, live in [@shuji-bonji/pdf-constraints](https://www.npmjs.com/package/@shuji-bonji/pdf-constraints). Every report names the version that decided it, because the rules move as constraints are added.

Each constraint resolves to one of four states:

| State | Meaning |
|---|---|
| `pass` | Nothing in this constraint could be disproved |
| `fail` | Disproved, with the fact and its measured value as evidence |
| `not_applicable` | The clause does not apply to this document |
| `needs_external_fact` | A fact outside the file was not supplied, so the constraint was **not decided** |

Two things the report distinguishes deliberately:

- **`needs_external_fact` is not a pass.** Whether a font is a *subset* is known only to whoever made it — the PDF does not say. Supply it with `given: { isSubset: true }`; without it the constraint degrades rather than defaulting into silent approval.
- **Some failures are traces, not violations.** Where a clause addresses the PDF *processor* (the act of writing), a file can only show that someone broke it — §14.3.4 explicitly allows leaving an existing inconsistency alone, so the last writer is not necessarily at fault.

Because these are T1 clauses, a failure can be stated plainly and its clause ID quoted — retrieve the wording with pdf-spec-mcp's `get_requirements`.

## PDF/UA validation (v0.6)

Pass `flavour: "pdfua-1"` (or `"pdfua-2"`) to validate accessibility conformance against ISO 14289. veraPDF is delegated to with `--flavour ua1` when installed; otherwise 12 native rules run: `MarkInfo`/`Marked`, `StructTreeRoot`, `pdfuaid` declaration, `/Lang`, `DisplayDocTitle`, document title, Figure `/Alt`, image tagging, heading hierarchy, table `TH`/`TR`, Link `/Contents`, and encryption barriers. Tags are resolved through `/RoleMap`.

PDF/UA native violations carry a `severity`: only `error` rules can prove non-conformance, while `warning` rules flag what needs human review. Accessibility is not fully machine-decidable — whether alt text is *present* is checkable, whether it is *meaningful* is not.

The native subset stops where pdf-lib does. Rules needing content-stream analysis — 7.1-3 (content marked as artifact or tagged), 7.2-34 (language of page content), 7.18.1-1 (annotations nested in `Annot` tags), 7.18.3-1 (`/Tabs`) — are left to veraPDF rather than approximated. Install veraPDF when accessibility matters.

> Without an explicit flavour, PDF/UA is selected only when the document declares PDF/UA and not PDF/A. Use pdf-reader-mcp's `inspect_tags` to examine the structure tree itself; conformance judgment lives here.

## Installation

As a plugin (via the [shuji-bonji/claude-plugins](https://github.com/shuji-bonji/claude-plugins) marketplace, recommended):

```bash
/plugin marketplace add shuji-bonji/claude-plugins
/plugin install pdf-verify-mcp@shuji-bonji
```

Or add directly to your MCP config:

```json
{
  "mcpServers": {
    "pdf-verify": {
      "command": "npx",
      "args": ["-y", "@shuji-bonji/pdf-verify-mcp@latest"]
    }
  }
}
```

> **Use `@latest` (or pin a version).** `npx -y <pkg>` without a version keeps running whatever it cached the first time — `-y` only skips the install prompt, it does not check for updates. To clear a stale cache: `rm -rf ~/.npm/_npx`.

## Usage examples

- "Verify the signatures in /path/to/contract.pdf — has it been altered since signing?"
- "Was this certified PDF modified after certification?"
- "Is this signature LTV-enabled (B-LT or B-LTA)?"
- "Does this document declare PDF/A-2b conformance?"

## Development

```bash
npm install
npm test           # vitest (fixtures are generated in-memory)
npm run build
npm run check      # biome lint + format
npm run test:fixtures  # write sample signed/tampered PDFs to tests/fixtures/generated/
```

Test fixtures (self-signed certificate + signed PDFs) are generated programmatically with pkijs + WebCrypto — no binary assets in the repository.

## License

MIT © shuji-bonji

Dependencies: pkijs / asn1js (BSD-3-Clause), pdf-lib (MIT), @modelcontextprotocol/sdk (MIT), zod (MIT).
