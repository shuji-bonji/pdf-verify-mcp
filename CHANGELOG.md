# Changelog

All notable changes to this project will be documented in this file.

## [0.14.0] - 2026-08-04

### Fixed

- **DocMDP violations are now assessed against what the permission actually grants, not only
  against P=1.** The check was a single expression —

  ```ts
  violatedByLaterChanges: permission === 1 && laterChanges && !laterChangesAppearLtvOnly
  ```

  — so **P=2 and P=3 could never be reported as violated, whatever was appended.** A document
  certified with P=2 that gained an annotation after certification read as clean, although
  ISO 32000-2 **Table 257** grants annotation creation only from P=3 and says of everything else
  that it "shall invalidate the signature".

  This failed open rather than closed: `evaluate_policy`'s `POL-REVIEW-DOCMDP-VIOLATION` fires on
  this field, so such a document was not raised to `human_review_required` either — it came back
  `use_with_caution`, which is the verdict for an ordinary unverified-signer document.

  The fix is not a stricter threshold but a different question — **what kind of change was it**,
  which the object-level diff (0.10.0) already had the material to answer. Each changed object now
  carries a machine-readable `changeClass` (`form-fill` / `signature` / `annotation` /
  `housekeeping` / `bookkeeping` / `content` / `unknown`) and the assessment compares those against
  the classes the P value permits.

  Objects that a *permitted* change necessarily drags along are classified as `housekeeping` and do
  not by themselves constitute a violation: measured on a lawful P=3 annotation addition, the page
  (whose `/Annots` grew), the catalog, the `/Info` dictionary and the XMP stream all move. Counting
  those as changes in their own right would make **every** certified document violate.

### Added

- **`certification.violationAssessment`** — three-valued: `permitted` / `violated` /
  `indeterminate`, with `certification.assessmentReason` giving the one-line why.

  **`indeterminate` is not a pass.** It is returned when bytes were appended but the
  cross-reference chain could not be walked, the chain is incomplete, or a changed object's kind
  could not be read (objects inside an object stream, for instance). This is the same discipline as
  `validate_clauses` returning `needs_external_fact` rather than defaulting a check into a pass:
  this server disproves, and "could not be disproved" is a different statement from "is fine".

  `violatedByLaterChanges` (boolean) is kept for compatibility and equals
  `violationAssessment === 'violated'` — note that it therefore **collapses `indeterminate` to
  `false`**. Read `violationAssessment` when "could not tell" must not be mistaken for "fine".

- **`POL-REVIEW-DOCMDP-INDETERMINATE`** in `evaluate_policy`: an undetermined DocMDP assessment now
  raises the verdict to `human_review_required` too. Reviewing a handful of unreadable files is the
  cheaper error.

- **`RevisionObjectChange.changeClass`** — the machine-readable counterpart to `role`. `role` is
  prose for a reader and may be reworded; rules read `changeClass`.

### Notes

- Found by the C-3b signature-specimen corpus (PDFfamily `specs/25` §4.1.1): specimens certified at
  P=1 / P=2 / P=3 with the *same* annotation appended afterwards. The 43-case boundary eval carries
  only a P=1 specimen, so 26 full runs never touched this path.

## [0.13.0] - 2026-07-29

### Fixed

- **A configured-but-unusable veraPDF is no longer treated as found (V-A3).** `PDF_VERIFY_VERAPDF`
  was accepted without checking that it points at something executable, while every other
  candidate location was checked with `access(X_OK)`. A stale path — the ordinary consequence of
  moving or upgrading veraPDF — therefore passed the lookup and only failed later inside
  `execFile`, so `validate_conformance` returned `veraPDF execution failed: spawn … ENOENT` and
  no report at all. The honest answer is "the validator you configured is not there, and nothing
  authoritative was run"; that is what it says now.

  A wrong setting is **not** silently replaced by another executable found on PATH. A verdict
  from a validator nobody chose is worse than no verdict: with `engine: "auto"` the report falls
  back to the native subset and states the non-execution, and with `engine: "verapdf"` it fails
  with the new code **`VERAPDF_NOT_AVAILABLE`** (`VERAPDF_NOT_FOUND` still means "not installed
  anywhere").

  Found by the family's boundary eval (`Document-Note/mcps/PDFfamily/evals/boundary`), whose E-6
  case could never be scored because the fallback it was written to observe did not exist.

### Added

- **`validate_conformance` reports whether the authoritative validation actually ran.** The
  report carries `authoritativeValidation`: `{ performed: true, validator, path }`, or
  `{ performed: false, reason, detail }` with `reason` one of `not_installed`,
  `configured_path_unusable` or `native_engine_requested`. In markdown it appears **above** the
  rule counts, not in the notes at the bottom — a reader who meets "13 checked, 13 passed" first
  has already formed a verdict by the time a footnote says veraPDF never spoke.

  `engine: "native"` said this implicitly before. Implicitly is the problem: a subset result is a
  weaker claim than a veraPDF result, not a lighter version of the same one, and "no violations
  detected" reads as a pass to anyone who does not already know the difference.

- **`evaluate_policy` carries the non-execution into its advisories.** When the archival check
  ran without veraPDF, an advisory says long-term preservation suitability is undetermined rather
  than confirmed. **The verdict is unchanged** — advisories never move it (this is the same shape
  as the V-A1 / V-A2 fixes in 0.7.1).

## [0.12.0] - 2026-07-28

### Added

- **`validate_clauses` now covers annotations (ISO 32000-2 §12.5).** The bundled constraint
  package moves from `@shuji-bonji/pdf-constraints` 0.1.0 to **0.3.0**, which adds a third
  domain, `annotation` (CT-ANNOT-1〜15): the appearance dictionary a writer owes, paragraph
  breaks in `Contents`, the syntax of `C` / `BM` / `F`, `QuadPoints` winding, the `Popup` and
  `IRT` relationships, and the rule that an annotation dictionary belongs to exactly one page.

  `AP` is the reason the domain was worth adding. ISO 32000-1 left the appearance dictionary
  optional and 32000-2 made it a `shall` for writers, so a validator built on 32000-1 — which is
  what PDF/UA-1 validation is — never asks the question. This is the same ground the font domain
  occupies: **things veraPDF is not looking for.**

  The domain list is read from the package, so `domains` and the tool description pick it up
  without a code change here.

- **Failures can now carry a Context line.** A constraint may attach a note explaining why its
  failure needs reading with care, and that note travels with the failure into the report.

  The case that forced it: R-12.5.6.10-5 requires `QuadPoints` vertices in counterclockwise
  order, and virtually every writer in existence uses Z order instead — deliberately, because
  following the clause literally breaks rendering in major viewers. Reported bare, that failure
  says "the vertex order is wrong" about almost every annotated PDF ever produced. It is true
  and it is misleading. **Context that does not travel with the failure does not exist.**

## [0.11.0] - 2026-07-27

### Added

- **PDF/A-4 can now be asked for (M-9).** `validate_conformance(flavour: "pdfa-4")` used to come
  back `INVALID_FLAVOUR`: the flavour parser accepted parts 1-3 only, so the family had no way
  to put a question about the newest part of ISO 19005 to veraPDF at all. `pdfa-4`, `pdfa-4e`
  and `pdfa-4f` are now accepted and mapped to veraPDF's profile ids `4` / `4e` / `4f`.

  The trap here is that **PDF/A-4 has no conformance level.** `4b` does not exist, and the old
  code defaulted an absent level to `b` — applied to part 4 that would have sent veraPDF a
  profile id no profile answers to. `E` and `F` are *variants*, not levels, and they are carried
  in the same field because they occupy the same slot in both places that name them: the
  `pdfaid:conformance` property and the veraPDF profile id. Combinations that name nothing real
  (`pdfa-4b`, `pdfa-2e`) are rejected here rather than passed downstream, and an XMP declaration
  that pairs part 4 with `B`, or part 2 with `F`, has the stray token dropped.

  Two native rules move, and **only two** — the native rule set was written from ISO 19005-1/-2,
  and ISO 19005-4 is outside this family's corpus (T2), so anything not visible from PDF 2.0
  itself is left to the oracle rather than guessed at:

  - `pdf-version` takes no range for part 4. PDF/A-4 is built on ISO 32000-2, so the file either
    carries a 2.0 header or it does not.
  - `output-intent` no longer applies to part 4. Whether -4 requires one unconditionally cannot
    be read from any text on hand, and asserting the -1..-3 requirement would have manufactured
    a failure out of a guess.

  Every native PDF/A-4 result now carries a note saying it ranks below veraPDF. Native rules
  passing on a PDF/A-4 file means less here than it does for the older parts, and the report
  says so rather than leaving the reader to know it.

  Measured against veraPDF 1.30.0: `pdfa-4` and `pdfa-4e` check 109 rules, `pdfa-4f` fails one
  more than either, and the violations come back with `ISO 19005-4:2020` rule ids — which is the
  evidence that the -4 profile is the one running, rather than a 1.7-era profile answering to a
  new name. `pdfa-4b` is still refused. PDF/UA-1 is unmoved at 106/106.

  Note on what this does *not* change: PDF/A-4 remains **T2**. veraPDF having a profile for it is
  not the same as this family being able to read ISO 19005-4, so a -4 result is still "veraPDF
  judged this", never "conforms to ISO 19005-4".

## [0.10.0] - 2026-07-27

### Added

- **`verify_integrity` now says *which objects* an incremental update wrote (V-F2 / Issue #8).**
  The tool could say "574 bytes were added after this signature" but not whether those bytes
  were an annotation, a form field value, or a page's content — which is the difference between
  a countersignature and a rewritten payment amount. It now walks the cross-reference chain in
  the raw bytes (`startxref` → `/Prev`, classic tables, cross-reference streams and
  hybrid-reference files) and reports, per revision, the objects added / rewritten / freed, each
  with the `/Type` written *in that revision* and a plain-language role. Objects written after
  the last signed range are also collected into `objectChangesAfterLastSignature`, the shortlist
  UC-10 hands on for locating.

  **No verdict moves.** Incremental updates are legal (ISO 32000-2 §7.5.6), so this is facts,
  not judgement — `evaluate_policy` reads the same fields it always did and its rule table is
  untouched. The diff is deliberately not built on pdf-lib: pdf-lib merges the whole chain into
  one view of the document, which is precisely the information that has to be kept apart here.

  Three ways the naive version would have lied, and what was done about each:

  - **A linearised file** (ISO 32000-1 Annex F) carries two cross-reference sections for a
    single save. Following the chain turns that into "revision 2 added every object". The
    giveaway is that the newer section sits at a *lower* offset; the two are merged back into
    the one revision they belong to. Measured on the reader's `linearized.pdf`: 2 revisions and
    10 phantom additions before, 1 revision after.
  - **A full save** ("Save As" rather than an incremental update) can rewrite six figures of
    objects — 224,065 in one 30 MB specimen. The listing is capped, `changeCount` keeps the
    true total, and the cut drops cross-reference/object-stream bookkeeping before content.
  - **A chain that cannot be walked returns `null`, never an empty list.** The two are
    indistinguishable to a reader otherwise, and "no diff" must not be readable as "nothing
    changed". A file whose last `startxref` points nowhere is reported explicitly as such: the
    bytes appended last are then not represented by any listed revision.

  Verified against 128 PDFs on hand (ISO specifications, generated fixtures, encrypted and
  linearised files, and a real sign-then-annotate specimen): 0 errors, 1 refusal — the
  deliberately corrupted one. On the sign-then-annotate specimen the diff separates the signing
  revision (signature dictionary, widget, AcroForm) from what followed it (a `Highlight`
  annotation and the page that now references it), which is the UC-10 question stated exactly.

  Object types are read from the raw bytes rather than from a parsed document, so they stay
  revision-accurate and keep working on encrypted files — dictionary keys and name values are
  not encrypted (ISO 32000-1 §7.6.2). Objects stored inside an object stream are the exception:
  they are flagged `inObjectStream` with no type rather than guessed at.

  A trial run against ISO 32000-2 itself set the last two numbers: at a cap of 200 the JSON
  response overran the 25,000-character limit and was cut mid-structure, and most of what filled
  it was object-stream members carrying nothing but their number. The cap is 25 per revision, and
  what survives the cut is ranked by how much it tells a reviewer — objects whose type could be
  read first, then object-stream members, then bookkeeping. Measured across the same 128 files,
  the largest `revisions` payload is now 11 KB.

## [0.9.0] - 2026-07-26

### Fixed

- **Roughly one signature in 256 was reported as unparseable (V-P1).** `/Contents` holds the CMS
  in a fixed-size slot padded with zero bytes, and the parser removed *every* trailing zero to
  get the CMS back. But a DER blob may legitimately end with `0x00` — measured at 0.7% of
  signatures here — and cutting that byte truncates the structure. `fromBER` then rejects it,
  so a valid signature came back as "CMS payload is not valid BER/DER": a false alarm in the
  one direction that matters for a tool whose job is deciding whether to trust a document.

  The parser now takes the length from the DER header and cuts where the structure says it
  ends, falling back to the old behaviour only when the header is not a definite-length
  SEQUENCE. Measured over 600 generated signatures: 4 ended in `0x00` — every one of which the
  previous code broke — and all 600 now verify.

  It surfaced as a test that failed once every few hundred runs (`aia-tsa`, TSA trust
  evaluation), which is exactly what a 1/256 chance looks like from the outside. The regression
  test does not wait for that luck: it generates signatures until it draws one ending in
  `0x00`, then asserts both that the naive trim breaks it and that the current code does not.

### Added

- **`validate_clauses` — constraints mapped from ISO 32000-1/-2 clauses (T1).** This is ground
  the other tools do not cover: `validate_conformance` judges the PDF/A and PDF/UA *profiles*
  (and delegates to veraPDF for the authoritative answer), but a file can satisfy those and
  still violate the specification body. Embedding a CFF font program under `/FontFile2` —
  forbidden by Table 124 — is a real case that surfaced only as a viewer warning and was
  filed under "harmless" for two days.

  The mapping from clause to structural condition, and its evaluation, live in
  [@shuji-bonji/pdf-constraints](https://www.npmjs.com/package/@shuji-bonji/pdf-constraints);
  this server calls it and translates the result. The dependency is **pinned exactly**, and
  every report names the version that decided it — npx caches a server's dependency tree until
  the server's own version changes, so a range would neither deliver table updates nor keep the
  rules reproducible across environments.

  Results keep four states rather than collapsing into pass/fail. `needs_external_fact` exists
  because some clauses depend on facts the file does not contain — whether a font is a *subset*
  is known only to whoever made it — and defaulting those into a pass would manufacture silent
  approval. Failures carrying `traceOnly` are worded as *traces*: those clauses address the PDF
  processor, and §14.3.4 explicitly permits leaving an existing inconsistency alone, so the file
  shows that someone broke the rule, not that the last writer did.

  Since these are T1 clauses, a failure can be stated plainly with its clause ID — the wording
  comes from pdf-spec-mcp's `get_requirements`. The tool description, the `instructions` and
  both READMEs say the same thing about its limit: no failures means nothing in the *bundled*
  constraints could be disproved, never that the document conforms.

## [0.8.0] - 2026-07-25

### Added

- **PAdES results now say what they are: an observation, not a conformance verdict
  ([#9](https://github.com/shuji-bonji/pdf-verify-mcp/issues/9)).**

  `detect_pades_level` has always been structural — the tool description said so — but the
  *output* did not. It read `Detected level: B-T`, which is indistinguishable from a verdict. So
  the level was being lifted into reports as "conforms to PAdES B-T", which this server has no
  standing to claim: ETSI EN 319 142 is not in the family's corpus, and unlike PDF/A there is no
  third-party validator to delegate the judgement to.

  - **`normativeBasis: 'T3'`** on every `PadesLevelReport`, and carried through
    `evaluate_policy`'s `facts.padesLevels`. Machine-readable, so a caller can branch on it
    instead of parsing prose.
  - The note is now *"The structure matches PAdES B-T … This is an observation of structure, not a
    conformance verdict"*. The markdown puts that caveat **above** the levels, because a caveat
    printed after the number is read after the number.
  - The two PAdES advisories keep their existing wording (callers match on it) and gain a clause
    saying the level is inferred from structure, not from ETSI text.
  - `evaluate_policy`'s notes gain one line, only when the document has signatures — no
    disclaimer where there is nothing to disclaim. Its `## PAdES levels` heading carries the
    caveat too: a note in the trailing Notes section is read *after* the number it qualifies.

- **The server now sends `instructions` on `initialize`.** This server is read as *proving*
  conformance and trust; it can only disprove. The instructions state that, then set out the
  three tiers (T1 quotable / T2 veraPDF decides / T3 observation only) so that a caller knows
  which vocabulary a given result licenses. They also restate the two limits that get forgotten
  most: a `valid` verdict without trust anchors is cryptography, not identity; and if revocation
  could not be checked, "not revoked" cannot be claimed either.

### Changed

- `specs/09 §2` (family scope) previously defined T3 as *"hold; issue no verdict"*, which
  contradicted a tool that returns four levels. The boundary has been redrawn: **T3 forbids a
  conformance verdict, not an observation of structure.** "This signature has an RFC 3161
  timestamp and a DSS covering the signer" is a fact in the file; "this conforms to B-LT" needs
  the standard. The same distinction `pdf-reader-mcp` makes about itself — and `detect_pades_level`
  was already named for it (`detect`, not `validate`).

## [0.7.1] - 2026-07-23

### Fixed (`evaluate_policy` advisory gaps — [FINDINGS-2026-07-20](docs/FINDINGS-2026-07-20.md))

Two cases where a fact that should reach the caller was silently dropped. Both
are **advisory-only — the verdict never changes**; the deterministic rule engine
is untouched. Found during live pdf-trust Skill trialling (PDF family ④).

- **V-A1 — post-signing changes on non-certified signatures are now surfaced.**
  Previously the "bytes were added after the signed range" fact only reached
  `facts`/`advisories` through the DocMDP (`certification?.`) path, so an
  ordinary (non-certified) signature followed by an incremental update produced
  no facts entry and no advisory at all. `evaluate_policy` now (a) exposes
  `incrementalUpdateCount`, `lastSignatureCoversFile` and
  `signaturesWithLaterChanges` in the returned `facts`, and (b) adds a
  non-certified advisory when content was added after signing. Incremental
  updates are legal in PDF (counter-signatures, DSS/LTV, annotations), so the
  verdict is deliberately unchanged; the certified path already reports its own
  case, so the new advisory stays silent there to avoid double-reporting.

- **V-A2 — non-PAdES (`level === null`) signatures no longer slip past the
  PAdES advisory.** The `p.level !== null` guard (added to stop
  `order.indexOf(null) === -1` mis-sorting) excluded legacy
  `adbe.pkcs7.detached` / ISO 32000-1 signatures from the PAdES-level check —
  even though they have weaker long-term verifiability than B-B (no signature
  timestamp, no DSS). They now get a distinct advisory that does not presuppose
  a PAdES baseline (the B-B "consider LTV augmentation" wording only applies to
  actual PAdES signatures). Verdict unchanged.

## [0.7.0] - 2026-07-19

### Added (Issue [#4](https://github.com/shuji-bonji/pdf-verify-mcp/issues/4))

- **`evaluate_policy` — deterministic 4-value trust verdict.** "The judge is
  code, the narrative is the LLM": the pdf-trust skill's judgment table
  (SKILL.md + profile references) is now a fixed rule engine
  (`services/policy-engine.ts`) over the facts produced by the existing tools.
  Same facts + same profile = same verdict, immune to LLM interpretation
  drift, content over-fitting, and silent model updates.
  - Runs `verify_signatures` / `verify_integrity` / `detect_pades_level`
    internally (plus `validate_conformance` for long-term-preservation
    profiles) from a `file_path` — the LLM never sits between the facts and
    the verdict. The long-term check always targets PDF/A: when the document
    declares no PDF/A flavour, `pdfa-2b` is forced so that a PDF/UA-only
    declaration cannot re-route preservation checking to accessibility
    (found in live trialling).
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
