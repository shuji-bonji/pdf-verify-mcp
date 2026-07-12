# Changelog

All notable changes to this project will be documented in this file.

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
