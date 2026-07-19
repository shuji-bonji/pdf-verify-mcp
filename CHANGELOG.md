# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added (v0.7.0 candidate — Issue [#4](https://github.com/shuji-bonji/pdf-verify-mcp/issues/4))

- **`evaluate_policy` — deterministic 4-value trust verdict.** "The judge is
  code, the narrative is the LLM": the pdf-trust skill's judgment table
  (SKILL.md + profile references) is now a fixed rule engine
  (`services/policy-engine.ts`) over the facts produced by the existing tools.
  Same facts + same profile = same verdict, immune to LLM interpretation
  drift, content over-fitting, and silent model updates.
  - Runs `verify_signatures` / `verify_integrity` / `detect_pades_level`
    internally (plus `validate_conformance` for long-term-preservation
    profiles) from a `file_path` — the LLM never sits between the facts and
    the verdict.
  - Profiles: `general`, `contract` (signature required, B-T recommended),
    `financial` (long-term checks, B-LT recommended), `legal`, `medical`
    (most conservative — use_with_caution escalates to
    human_review_required), `government` (long-term checks, B-LTA
    recommended).
  - Returns `verdict`, `firedRules` (rule IDs with per-rule verdict and
    reason), `advisories` (recommendations that never change the verdict,
    e.g. LTV augmentation), and a compact facts summary.
  - Verdict severity: reject > human_review_required > use_with_caution >
    trust_and_use. `trust_and_use` requires all signatures valid + trusted +
    revocation confirmed good and no rule fired.
  - Rules: POL-REJECT-INVALID / POL-REJECT-REVOKED /
    POL-REVIEW-INDETERMINATE / POL-REVIEW-DOCMDP-VIOLATION /
    POL-REVIEW-UNSIGNED-REQUIRED / POL-CAUTION-UNSIGNED /
    POL-CAUTION-TRUST-NOT-EVALUATED / POL-CAUTION-TRUST-UNTRUSTED /
    POL-CAUTION-REVOCATION-UNKNOWN / POL-CAUTION-WEAK-DIGEST /
    POL-ESCALATE-CAUTION.

## [0.6.3] - 2026-07-19

Encrypted-document handling for PDF/UA validation
([#7](https://github.com/shuji-bonji/pdf-verify-mcp/issues/7)).

### Fixed

- **Encrypted documents no longer produce false PDF/UA violations.**
  Previously `validate_conformance` read an encrypted document's ciphertext
  structures as-is, so a tagged document failed `ua-struct-tree`
  ("No /StructTreeRoot") and two rules crashed with raw pdf-lib exceptions.
  Now:
  - The document is **decrypted first** (new `services/decrypt-document.ts`,
    built on the v0.5 decryptor): every raw stream/string in the xref is
    decrypted — including encrypted object streams recovered from pdf-lib's
    `PDFInvalidObject` — /Encrypt is dropped, and the plaintext rebuild is
    validated. The empty user password is tried automatically, so
    permission-encrypted PDFs validate fully with no parameters. Decrypted
    object streams are **expanded into plain indirect objects** before
    serialization: pdf-lib tolerates xref entries missing for ObjStm-contained
    objects, but qpdf/veraPDF correctly reject them (found because veraPDF
    returned no validation result on the rebuild; after expansion the rebuild
    passes veraPDF 106/106 on the reference fixture).
  - `ua-no-encryption-barrier` is still judged against the **original**
    /Encrypt dictionary (ISO 14289-1, 7.16) — decryption does not hide a
    cleared accessibility bit.
  - When decryption is impossible (unknown password), structure-dependent
    rules are reported as **`checked: false` / `skippedRules`** instead of
    failed — a skipped rule is neither a pass nor a violation. Only
    `ua-no-encryption-barrier` still runs (the /Encrypt dictionary is
    plaintext). `engine: "verapdf"` raises `ENCRYPTED_PDF` instead, since
    veraPDF cannot read the file either.
  - Signature `/Contents`, XRef streams, and (when `/EncryptMetadata` is
    false) Metadata streams are never decrypted, per ISO 32000-2 §7.6.2 /
    §7.5.8.2.
  - Rule-check exceptions now say "Rule check could not complete (the
    document structure may be malformed or unreadable)" instead of leaking
    raw pdf-lib messages.
  - PDF/A is intentionally unchanged: ISO 19005 forbids encryption outright,
    so an encrypted file is judged as-is.

### Added

- `validate_conformance` gains a **`password`** parameter (same semantics as
  `verify_signatures`).

## [0.6.2] - 2026-07-19

Spec-conformance fixes from the pdf-spec-mcp audit
([#5](https://github.com/shuji-bonji/pdf-verify-mcp/issues/5)), each traced to
the ISO originals via pdf-spec-mcp.

### Fixed

- **`ua-title` now requires XMP `dc:title`** (ISO 14289-1, 7.1). The rule
  previously accepted Info `/Title` as an alternative, but the spec requires
  the Metadata stream to contain `dc:title` and states that a conforming
  reader shall ignore the document information dictionary. A document with
  only Info `/Title` now fails, with a detail explaining the difference.
- **DocMDP P=1 no longer flags DSS/document-timestamp updates as violations**
  (ISO 32000-2 §12.8.2.2). The spec permits "subsequent DSS (12.8.4.3) and/or
  document timestamp (12.8.5) incremental updates" even when P=1. When bytes
  were added after a P=1 certification but a DSS and/or a later document
  timestamp is present, `verify_integrity` reports
  `violatedByLaterChanges: false` with the new
  `certification.laterChangesAppearLtvOnly: true` and an explanatory note.
  Detection is structural — object-level confirmation that the updates
  contain nothing else is not performed, and the note says so. This removes
  the false "violated" verdict on legitimate B-LT/B-LTA documents that
  pdf-trust audits depend on.
- **`ua-no-encryption-barrier` now actually inspects `/Encrypt /P` bit 10**
  (clause corrected from "7.1 (10)" to ISO 14289-1, 7.16). Previously the rule
  failed every encrypted document with "could not be verified here". It now
  reads the encryption dictionary: bit 10 set passes, bit 10 clear (or a
  missing `/P` key, which 7.16 also forbids) fails. Severity raised from
  `warning` to `error` accordingly.

## [0.6.1] - 2026-07-16

Maintainability release addressing the refactoring suggestions from the 16 July
code review ([#2](https://github.com/shuji-bonji/pdf-verify-mcp/issues/2)).
No behaviour changes to verification results.

### Changed

- **Certificate/CRL name matching** goes through a single `canonicalName()` in
  `src/utils/rdn.ts`. Four copies of the same raw-OID `type=value` join
  (`subjectName`, `issuerName`, `crlIssuerName`, and the inline rebuild in
  `findIssuerCert`) are gone. `formatRdn` (display) and `canonicalName`
  (matching) are documented as intentionally separate — they use different
  separators and attribute names.
- **PDF/UA rule engine**: the `/RoleMap` is built once in `validatePdfuaNative`
  and passed to rules via the context (the `WeakMap` cache is no longer needed).
  The structure-tree walk is now iterative with an explicit stack, so deeply
  nested trees cannot overflow the call stack; `/K` document order is preserved.
- **XMP identification helpers**: `extractPdfaId()` / `extractPdfuaPart()` in
  `conformance.ts` are now the single home of the `pdfaid`/`pdfuaid` regexes,
  shared by `identify_conformance`, flavour resolution, PDF/UA auto-selection,
  and the `ua-xmp-declaration` rule (three duplicated copies removed).
- **`PDFDocument.load` options centralised** in `loadPdfDocument()`
  (`pdf-parser.ts`), shared by parsing and both native conformance paths.
- **`validate_conformance` tool description** derives the native rule counts
  from the rule sets (was hard-coded "~15"/"~12"), so the numbers stay accurate
  as rules are added.
- **Heading-hierarchy rule** documents its known limitation: levels are checked
  in document order across the whole tree, so branch-local level restarts are
  not distinguished. A redundant branch in the no-headings path was removed.
- Rule-check exceptions in both native engines are now also logged at debug
  level (`DEBUG` env var); the failure was already surfaced in the rule detail.
- The biome version is pinned to an exact `2.5.4` (was `^2.3.14`, while the
  installed toolchain had moved to 2.5.4), and `biome.json`'s `$schema` now
  matches. Biome's formatting output changes between minor releases, so a caret
  range let a local `npm install` drift ahead of the pinned config and report
  diffs on files nobody had touched.
- Claude plugin manifest (`.claude-plugin/plugin.json`) version synchronised;
  its description now mentions PDF/UA (ISO 14289) alongside PDF/A.

## [0.6.0] - 2026-07-16

### Added

- **PDF/UA validation (ISO 14289)** in `validate_conformance` via
  `flavour: "pdfua-1"` / `"pdfua-2"`. Accessibility conformance was previously
  out of scope and deferred to pdf-reader-mcp's `validate_tagged`.

  The split now follows the family's boundary rule — reader reports _what is in_
  a document, verify judges _whether it conforms_. `validate_tagged` inspects the
  structure tree; conformance judgments belong here alongside PDF/A.
  - **veraPDF** is delegated to with `--flavour ua1` / `ua2` when installed
    (authoritative).
  - **Native subset (12 rules)** otherwise: `MarkInfo`/`Marked`, `StructTreeRoot`,
    `pdfuaid` declaration, `/Lang`, `DisplayDocTitle`, document title, Figure
    `/Alt`, image tagging, heading hierarchy, table `TH`/`TR`, Link `/Contents`,
    encryption barrier. Tags are resolved through `/RoleMap`, and the structure
    tree is walked via `/K` so heading order is preserved.

- **Rule severity** for PDF/UA native violations: `error` (definitive violation)
  vs `warning` (likely a problem, or only partly machine-checkable). Only `error`
  rules can set `compliant: false` — accessibility is not fully decidable by
  machine, and the report says so rather than implying certification.

### Changed

- Flavour resolution: an explicit `pdfua-*` flavour selects PDF/UA. Without one,
  PDF/UA is auto-selected only when the document declares PDF/UA and _not_ PDF/A;
  when both are declared PDF/A wins (unchanged behaviour) and a note points at
  `pdfua-1`.
- `validate_conformance` is retitled "Validate PDF/A and PDF/UA Conformance".

### Notes

Two PDF/UA rules exceed what pdf-reader-mcp's `validate_tagged` can check:
Figure `/Alt` presence (reader counts Figure tags but never reads the attribute)
and Link `/Contents`. Heading-order checking is equivalent. This is a migration
of responsibility, not a copy.

The veraPDF delegation was verified against a real installation: `--flavour ua1`
returned 106 rule results, and every native finding was corroborated. The native
subset deliberately stops where pdf-lib does — checks that need content-stream
analysis (7.1-3 content marked as artifact/tagged, 7.2-34 language of page
content, 7.18.1-1 annotations nested in Annot tags, 7.18.3-1 `/Tabs`) are left
to veraPDF rather than approximated.

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
