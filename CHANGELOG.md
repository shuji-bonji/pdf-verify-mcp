# Changelog

All notable changes to this project will be documented in this file.

## [0.5.2] - 2026-07-14

### Added

- **Claude Code plugin manifest** (`.claude-plugin/plugin.json`): the server can
  now be installed as a plugin from the
  [shuji-bonji/claude-plugins](https://github.com/shuji-bonji/claude-plugins)
  marketplace (`/plugin install pdf-verify-mcp@shuji-bonji`) in addition to the
  manual `mcpServers` config.

### Changed

- READMEs (en/ja) document the plugin installation route.

## [0.5.1] - 2026-07-13

Fixes from a consolidated code review (security & correctness).

### Fixed

- **Encrypted PDF password validation (R2–R4)**: `create()` now verifies the
  user password against /U (Algorithm 4/5). Previously any password derived a
  key and reported `decrypted: true`, emitting mojibake for wrong passwords.
- **AES-256 (R6) key derivation off-by-one**: Algorithm 2.B termination is now
  `round − 31` (iteration count − 32), matching pdf.js / iText / mupdf. Fixes a
  rare (~1%) boundary case where the correct empty password was rejected.
- **CRL trust**: fetched (online) CRLs are now matched to the certificate's
  issuer and their signature is verified with the issuer certificate. An
  unverified CRL is reported as `unknown` with a caveat instead of being
  trusted to force an `invalid` verdict. Applies to embedded CRLs too.
- **AESV3 key-length guard**: AES-256 uses the file key directly and a
  key/algorithm length mismatch is handled without emitting ciphertext.
- **stdout guard**: moved to a side-effect module imported first, so it is
  installed before dependency modules are evaluated (ESM import hoisting).
- **certificatePath** now renders as `CN=..., O=...` (shared `formatRdn`)
  instead of raw attribute OIDs.
- Tool descriptions updated: removed stale "not supported in v0.1" notes for
  trust evaluation, LTV validation, and conformance validation; documented the
  `verify_signatures` `password` argument.
- `pdfaid:conformance` regex corrected from `[A-Ua-u]` (a range that also
  matched C, K, …) to `[ABUabu]`.

### Added

- qpdf-based end-to-end decryption tests (AES-256/AES-128/RC4 permission
  encryption + wrong/missing password regression). CI installs qpdf.

## [0.5.0] - 2026-07-13

### Added

- Encrypted PDF decryption (ISO 32000-1 §7.6 Standard Security Handler):
  permission-encrypted PDFs (empty user password) are decrypted automatically,
  and a `password` parameter handles reader-password PDFs. Supports RC4
  (R2–R4), AES-128 (AESV2), and AES-256 (AESV3, R6). RC4 is implemented in
  pure JS since OpenSSL 3 disables it.
  - String metadata (field name, /M, /Reason, /Location) and the XMP stream
    are now recovered from encrypted documents instead of being omitted.
  - `ParsedPdf.decrypted` reports whether decryption succeeded.
- `verify_signatures` gains a `password` argument.

## [0.4.0] - Unreleased

### Added

- AIA chain completion (`check_revocation: "online"`): when the issuer
  certificate is not embedded in the CMS/DSS, it is fetched via the AIA
  caIssuers access method (bare DER or PKCS#7 bundle, depth-limited).
  This enables OCSP and full chain evaluation for signatures that embed
  only the leaf certificate (e.g. AWS invoices).
- TSA trust evaluation: when trust anchors are provided, the TSA certificate
  chain of signature timestamps (`tsaTrust` on the timestamp result) and
  document timestamps (report-level `trust`) is evaluated.

### Fixed

- Test fixture generator: XMP metadata stream /Length was counted in UTF-8
  while the template serializes as latin1 (flagged by veraPDF).

## [0.3.0] - Unreleased

### Added

- `validate_conformance`: PDF/A validation (ISO 19005) with a hybrid engine.
  - veraPDF delegation when installed (`PDF_VERIFY_VERAPDF` env var or on
    PATH) — authoritative results via `--format json`.
  - Native fallback: a built-in subset of ~15 high-value rules (encryption,
    trailer /ID, LZW/Crypt filters, PDF version limits, XMP declaration,
    OutputIntent, font embedding, JavaScript / prohibited actions, embedded
    files and transparency for A-1, XFA, NeedAppearances, catalog /AA), each
    with its ISO 19005 clause reference.
  - `flavour` parameter (e.g. "pdfa-2b"; defaults to the XMP declaration) and
    `engine` parameter ('auto' / 'verapdf' / 'native').
  - Native results are reported honestly: violations mean definitively
    non-compliant; all-passed means "no violations in the checked subset",
    never certification.
- PDF/UA documents get a pointer to pdf-reader-mcp's `validate_tagged`
  (accessibility validation stays in the reader's scope).

## [0.2.0] - Unreleased

### Added

- Trust chain evaluation: `verify_signatures` accepts `trust_anchors` (PEM/DER
  file paths) and reads the `PDF_VERIFY_TRUST_ANCHORS` env var (directory).
  Reports `trusted` / `untrusted` / `not_evaluated` with the certificate path,
  validated at the signing time via pkijs CertificateChainValidationEngine.
- Revocation checking: `check_revocation` parameter (`none` / `embedded` /
  `online`). Embedded mode parses OCSP responses and CRLs from the DSS and the
  CMS payload; online mode additionally queries the OCSP responder (AIA) and
  CRL distribution points over HTTP. A revoked signer forces verdict `invalid`.
- RFC 3161 timestamp verification: signature timestamps (unsigned attribute)
  and document timestamps are now fully verified — messageImprint match plus
  TSA CMS signature — with TSA subject and genTime reported.
- Content-level LTV validation in `detect_pades_level`: B-LT / B-LTA now
  require DSS revocation data that actually covers the signer certificate
  (otherwise the level is capped at B-T with an explanatory note).
- DSS parsing: Certs / OCSPs / CRLs streams are decoded and reported.
- Test fixtures: CA-chained certificates, CRLs, and RFC 3161 timestamp tokens
  generated in-memory; DSS embedding support in the PDF template builder.

### Fixed

- Large CRLs (e.g. DigiCert, ~500KB with tens of thousands of revoked entries)
  failed to parse because asn1js's default limit is maxNodes=10,000.
  Revocation structures are now parsed with raised limits
  (maxNodes 5M / maxContentLength 64MB).

### Changed

- `trust` in the verify_signatures report is now an object
  (`{ status, detail, certificatePath }`) instead of the fixed string
  `'not_evaluated'`.
- `verify_signatures` tool annotation `openWorldHint` is now `true`
  (online revocation may reach OCSP/CRL endpoints).

## [0.1.0] - Unreleased

### Added

- `verify_signatures`: cryptographic verification of PDF digital signatures
  (ByteRange digest vs CMS messageDigest, PKCS#7/CMS signature verification via pkijs,
  certificate summary). Supports `ETSI.CAdES.detached`, `adbe.pkcs7.detached`, and
  `ETSI.RFC3161` document timestamps (messageImprint check).
- `verify_integrity`: tamper detection via incremental update analysis,
  bytes-after-signed-range detection, and DocMDP certification violation checks.
- `detect_pades_level`: structural PAdES baseline level detection (B-B / B-T / B-LT / B-LTA).
- `identify_conformance`: PDF/A / PDF/UA declaration identification from XMP metadata.
- Reproducible test fixtures: self-signed certificate and signed/tampered PDFs
  generated in-memory with pkijs + WebCrypto (no binary assets).
- Encrypted PDF handling: string metadata (field name, /M, /Reason, /Location)
  is suppressed with an explanatory note instead of emitting undecodable
  ciphertext; cryptographic verification is unaffected.
- Legacy algorithm fallback: MD5-based signatures (e.g. AWS invoices) are
  verified via node:crypto since WebCrypto lacks MD5. Weak digest algorithms
  (MD5, SHA-1) are flagged in the report notes.

### Notes

- Trust chain evaluation and revocation checking are out of scope in v0.1;
  all verdicts carry `trust: 'not_evaluated'`.
