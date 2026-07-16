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
| `verify_integrity` | Tamper detection: incremental updates, changes after signing, DocMDP certification violations |
| `detect_pades_level` | PAdES baseline level (B-B / B-T / B-LT / B-LTA) with content-validated LTV data |
| `identify_conformance` | Declared PDF/A / PDF/UA conformance from XMP metadata |
| `validate_conformance` | PDF/A (ISO 19005) and PDF/UA (ISO 14289) validation: veraPDF when installed, built-in rule subset otherwise |

## Verdicts

| Verdict | Meaning |
|---------|---------|
| `valid` | ByteRange digest matches and the CMS signature is cryptographically valid |
| `invalid` | Digest mismatch or signature verification failure — possible tampering |
| `indeterminate` | Unsupported format or verification could not complete |

## Trust & revocation (v0.2)

Pass `trust_anchors` (PEM/DER file paths) or set the `PDF_VERIFY_TRUST_ANCHORS` env var (a directory of certificates) to evaluate the signer's chain: results are `trusted` / `untrusted` / `not_evaluated` with the certificate path, validated at signing time.

`check_revocation` controls revocation checking: `embedded` (default — OCSP/CRL data inside the PDF's DSS or the CMS payload), `online` (additionally query OCSP responders and CRL distribution points over HTTP), or `none`. A revoked signer certificate forces verdict `invalid`. In online mode, missing issuer certificates are fetched via AIA caIssuers to complete the chain (v0.4). When anchors are provided, TSA certificate chains of RFC 3161 timestamps are evaluated too (`tsaTrust`).

> Without trust anchors, `trust` stays `not_evaluated` and a `valid` verdict asserts cryptographic integrity, not signer identity.

Encrypted PDFs are decrypted automatically when permission-encrypted (empty user password); pass `password` for reader-password PDFs. Supported: RC4 (R2–R4), AES-128, AES-256 (R6). Decryption recovers string metadata (field name, /M, /Reason, /Location) and XMP — a signature's `/Contents` is exempt from encryption, so verification never depends on it.

Supported SubFilters: `ETSI.CAdES.detached` (PAdES), `adbe.pkcs7.detached`, `ETSI.RFC3161` (document timestamps). RFC 3161 signature timestamps are fully verified (imprint + TSA signature). Legacy MD5/SHA-1 signatures are verified via node:crypto and flagged as weak.

## PDF/A validation (v0.3)

`validate_conformance` uses a hybrid engine. With veraPDF installed (`PDF_VERIFY_VERAPDF` env var or on PATH) validation is delegated for authoritative results. Otherwise a built-in subset of ~15 high-value ISO 19005 rules runs natively (encryption, trailer /ID, LZW, font embedding, JavaScript/prohibited actions, OutputIntent, transparency for A-1, XFA, and more), each reported with its clause reference.

Native results are honest about their limits: violations mean definitively non-compliant; all-passed means "no violations in the checked subset" — never certification.

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
