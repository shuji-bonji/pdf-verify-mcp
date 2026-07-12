# pdf-verify-mcp

[日本語](./README.ja.md)

MCP server for PDF **authenticity verification** — cryptographic digital signature verification, tamper detection, PAdES baseline level detection, and PDF/A / PDF/UA declaration identification.

Part of the PDF family alongside [pdf-reader-mcp](https://github.com/shuji-bonji/pdf-reader-mcp) (structure analysis) and [pdf-spec-mcp](https://github.com/shuji-bonji/pdf-spec-mcp) (specification reference). Where `pdf-reader-mcp` tells you *what is in* a PDF, `pdf-verify-mcp` tells you *whether it is genuine*.

## Tools

| Tool | Purpose |
|------|---------|
| `verify_signatures` | Cryptographically verify digital signatures: ByteRange digest vs CMS messageDigest, PKCS#7/CMS signature verification, certificate summary |
| `verify_integrity` | Tamper detection: incremental updates, changes after signing, DocMDP certification violations |
| `detect_pades_level` | PAdES baseline level (B-B / B-T / B-LT / B-LTA) with structural evidence |
| `identify_conformance` | Declared PDF/A / PDF/UA conformance from XMP metadata |

## Verdicts

| Verdict | Meaning |
|---------|---------|
| `valid` | ByteRange digest matches and the CMS signature is cryptographically valid |
| `invalid` | Digest mismatch or signature verification failure — possible tampering |
| `indeterminate` | Unsupported format or verification could not complete |

> **Important (v0.1 scope):** Certificate trust chains are **not** evaluated against trust anchors — every result carries `trust: 'not_evaluated'`. A `valid` verdict asserts cryptographic integrity, not signer identity. Trust anchor support is planned for v0.2 (see [docs/PROJECT_PLAN.md](./docs/PROJECT_PLAN.md)).

Supported SubFilters: `ETSI.CAdES.detached` (PAdES), `adbe.pkcs7.detached`, `ETSI.RFC3161` (document timestamps, imprint check).

## Installation

```json
{
  "mcpServers": {
    "pdf-verify": {
      "command": "npx",
      "args": ["-y", "@shuji-bonji/pdf-verify-mcp"]
    }
  }
}
```

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
