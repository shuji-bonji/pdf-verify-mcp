/**
 * Markdown formatters for tool responses.
 */

import { CHARACTER_LIMIT } from '../constants.js';
import { veraPdfNote } from '../services/conformance-validation.js';
import type {
  CmsVerificationResult,
  ConformanceReport,
  DocMdpAssessment,
  IntegrityReport,
  PadesLevelResult,
  ReadingScope,
  RevisionChainCoverage,
  RevisionObjectChange,
  SignatureVerificationResult,
  Truncation,
} from '../types.js';
import { truncationLine } from './truncation.js';

/**
 * Cut a **markdown** body to CHARACTER_LIMIT. Never call this on JSON: a JSON
 * body is bounded by the per-array caps (utils/truncation.ts) and must stay
 * parseable (v0.29.0, #18).
 */
export function truncateIfNeeded(text: string): { text: string; truncated: boolean } {
  if (text.length <= CHARACTER_LIMIT) return { text, truncated: false };
  return {
    text: `${text.slice(0, CHARACTER_LIMIT)}\n\n…(truncated — use response_format: "json" for the complete report)`,
    truncated: true,
  };
}

/**
 * The body a tool returns: markdown goes through the character limit, JSON
 * goes out as is (v0.29.0, #18).
 */
export function renderBody(json: boolean, value: unknown, markdown: () => string): string {
  return json ? JSON.stringify(value, null, 2) : truncateIfNeeded(markdown()).text;
}

function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return 'unknown';
  return value ? 'yes' : 'no';
}

function formatCms(cms: CmsVerificationResult): string[] {
  const lines: string[] = [];
  lines.push(`- Digest match (ByteRange vs messageDigest): **${yesNo(cms.digestMatches)}**`);
  lines.push(`- Signature cryptographically verified: **${yesNo(cms.signatureVerified)}**`);
  lines.push(`- Digest algorithm: ${cms.digestAlgorithm ?? 'unknown'}`);
  if (cms.signingTimeAttribute)
    lines.push(`- Signing time (signed attr): ${cms.signingTimeAttribute}`);
  lines.push(`- Signature timestamp (RFC 3161): ${yesNo(cms.hasSignatureTimestamp)}`);
  if (cms.signatureTimestamp) {
    const ts = cms.signatureTimestamp;
    lines.push(
      `  - TST: imprint match=${yesNo(ts.imprintMatches)}, TSA signature=${yesNo(ts.signatureVerified)}${ts.genTime ? `, genTime=${ts.genTime}` : ''}${ts.tsaSubject ? `, TSA=${ts.tsaSubject}` : ''}`,
    );
  }
  lines.push(`- Embedded certificates: ${cms.embeddedCertificateCount}`);
  if (cms.signerCertificate) {
    const c = cms.signerCertificate;
    lines.push(`- Signer: ${c.subject}`);
    lines.push(`  - Issuer: ${c.issuer}`);
    lines.push(`  - Serial: ${c.serialNumber}`);
    lines.push(
      `  - Validity: ${c.notBefore} → ${c.notAfter}${c.isExpiredNow ? ' (EXPIRED now)' : ''}`,
    );
    lines.push(`  - Self-signed: ${yesNo(c.isSelfSigned)}`);
  }
  if (cms.error) lines.push(`- Diagnostic: ${cms.error}`);
  return lines;
}

/**
 * どこまで読んだかを、判定より前に置く行を組む。
 *
 * 数字だけを読ませない。`reconstructed` の文書では、相互参照表は verify が
 * 組み直したものであって、ファイルが持っているものではない —— それを知らずに
 * 「違反なし」を読むと、見ていない範囲を「問題なし」と受け取ることになる。
 */
export function formatReadingScope(scope: ReadingScope): string[] {
  const head: string[] = [];
  if (scope.sections !== null) head.push(`${scope.sections} cross-reference section(s)`);
  head.push(`${scope.objects} object(s)`);
  head.push(`chain ${scope.chainStop.kind}`);
  if (scope.encrypted) {
    head.push(
      scope.authenticated
        ? 'encrypted (key derived)'
        : '**encrypted, key NOT derived — no object could be read**',
    );
  }
  const lines = [`- Scope of this reading: ${head.join(', ')}`];
  if (scope.reconstructed) {
    lines.push(
      '  - **The cross-reference table was rebuilt by this tool from the objects found in the ' +
        'file. It is not the table the file carries, and revision boundaries cannot be stated.**',
    );
  }
  if (scope.continuedPastStop) {
    lines.push(
      '  - The chain stopped before the end; reading continued from the `startxref` values, ' +
        'which `/Prev` does not link.',
    );
  }
  if (scope.filledFromScan > 0) {
    lines.push(
      `  - ${scope.filledFromScan} object(s) listed by no cross-reference section were filled in ` +
        'by scanning the file for `N G obj`.',
    );
  }
  if (scope.newestSectionUnreadable) {
    lines.push(
      '  - The newest cross-reference section could not be read, so the bytes at the end of the ' +
        'file are not represented here.',
    );
  }
  if (scope.refusal) lines.push(`  - Recovered after: ${scope.refusal}`);
  return lines;
}

export function formatSignatureReports(result: SignatureVerificationResult): string {
  const reports = result.signatures;
  const scope = formatReadingScope(result.scope);
  if (reports.length === 0) {
    // 🔴 ここに射程が要る。「署名が無い」と「読めた範囲に署名が無い」は別で、
    // 表を組み直した文書では後者になりうる。見出しの直後に置く。
    return [
      '# Signature Verification',
      '',
      ...scope,
      '',
      'No signatures found in this document.',
    ].join('\n');
  }
  const lines: string[] = ['# Signature Verification', ''];
  lines.push(...scope, '');
  lines.push(`Signatures found: ${reports.length}`);
  lines.push(
    ...truncationLine(
      'Signature fields verified (the rest were NOT verified; evaluate_policy verifies all)',
      result.signaturesTruncated,
    ),
  );
  lines.push('');
  reports.forEach((r, i) => {
    lines.push(
      `## ${i + 1}. ${r.fieldName ?? '(unnamed field)'}${r.isDocumentTimestamp ? ' [DocTimeStamp]' : ''}`,
    );
    lines.push('');
    lines.push(`- Verdict: **${r.verdict.toUpperCase()}**`);
    lines.push(`- Trust: **${r.trust.status}**${r.trust.detail ? ` — ${r.trust.detail}` : ''}`);
    if (r.trust.certificatePath && r.trust.certificatePath.length > 0) {
      lines.push(`  - Path: ${r.trust.certificatePath.join(' → ')}`);
    }
    for (const ca of r.trust.chainRevocation ?? []) {
      lines.push(
        `  - CA revocation: ${ca.subject} — **${ca.status}**${ca.source ? ` (${[ca.source, ca.origin].filter(Boolean).join(', ')})` : ''}${ca.revocationTime ? ` — revoked at ${ca.revocationTime}` : ''}`,
      );
    }
    if (r.validationTime) {
      lines.push(`- Validation time: ${r.validationTime.time} (${r.validationTime.source})`);
    }
    if (r.revocation) {
      const where = [r.revocation.source, r.revocation.origin].filter(Boolean).join(', ');
      lines.push(
        `- Revocation: **${r.revocation.status}**${where ? ` (${where})` : ''}${r.revocation.revocationTime ? ` — revoked at ${r.revocation.revocationTime}` : ''}${r.revocation.thisUpdate ? ` — thisUpdate ${r.revocation.thisUpdate}` : ''}${r.revocation.detail ? ` — ${r.revocation.detail}` : ''}`,
      );
    }
    lines.push(`- SubFilter: ${r.subFilter ?? '(none)'}`);
    lines.push(`- Covers entire file: ${yesNo(r.coversEntireFile)}`);
    if ((r.bytesAfterSignedRange ?? 0) > 0) {
      lines.push(`- Bytes after signed range: ${r.bytesAfterSignedRange}`);
    }
    if (r.signingTimeDictionary) lines.push(`- Signing time (/M): ${r.signingTimeDictionary}`);
    if (r.reason) lines.push(`- Reason: ${r.reason}`);
    if (r.location) lines.push(`- Location: ${r.location}`);
    if (r.cms) lines.push(...formatCms(r.cms));
    for (const note of r.notes) lines.push(`- Note: ${note}`);
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * One line saying how much of the history the revision list covers.
 *
 * The wording names **which end** is absent rather than the cause; the cause
 * stays in `notes`, where there is room for it.
 */
function revisionChainLine(coverage: RevisionChainCoverage): string {
  if (coverage.status === 'unwalkable') {
    return 'Revision history: **NOT DETERMINED** — no cross-reference section could be read, so no revision is listed. This is not "nothing changed".';
  }
  if (coverage.status === 'complete') {
    return 'Revision history: complete (walked back to the original revision)';
  }
  const ends = coverage.missing
    .map((end) =>
      end === 'oldest'
        ? 'the oldest revisions (the chain ended before the original one)'
        : 'the newest revision (the last "startxref" was unreadable, so an older entry point was used)',
    )
    .join(' and ');
  return `Revision history: **PARTIAL** — ${ends} ${coverage.missing.length > 1 ? 'are' : 'is'} not in the list below`;
}

/**
 * One line reconciling the two revision counts, printed only when they differ.
 *
 * Same placement argument as `revisionChainLine`: the reader has just been told
 * "Revisions: 2" and the object-level section below lists one. Leaving the
 * reconciliation to `## Notes` at the bottom means they form a view of the file
 * first and meet the correction afterwards.
 */
function revisionCountLine(report: IntegrityReport): string | null {
  const agreement = report.revisionCountAgreement;
  if (agreement.status === 'agree') return null;
  const listed = report.revisions?.length ?? 0;
  const counted = `the count above is "startxref" keywords; the chain reached ${listed} cross-reference section(s)`;
  if (agreement.status === 'unaccounted') {
    return `Revision count: **UNEXPLAINED DIFFERENCE** — ${counted}, and nothing read from the file accounts for the gap`;
  }
  const causes = agreement.causes
    .map((cause) =>
      cause === 'linearised'
        ? 'the file is linearised (two cross-reference sections for one save)'
        : 'the chain was not followed in full (see the line above)',
    )
    .join('; ');
  return `Revision count: ${counted} — ${causes}`;
}

export function formatIntegrityReport(report: IntegrityReport): string {
  const lines: string[] = ['# Integrity Analysis', ''];
  lines.push(...formatReadingScope(report.scope));
  lines.push(`- File size: ${report.fileSize} bytes`);
  lines.push(
    `- Revisions: ${report.revisionCount} (incremental updates: ${report.incrementalUpdateCount})`,
  );
  // Immediately under the count, for the same reason the conformance report puts
  // the validator above the rule totals: a reader who meets "Revisions: 2" first
  // has already formed a view of the file by the time a note at the bottom says
  // the chain was cut. The object-level section below is skipped entirely when
  // the cut leaves a single revision, so this line is the only place it appears.
  lines.push(`- ${revisionChainLine(report.revisionChain)}`);
  const countLine = revisionCountLine(report);
  if (countLine) lines.push(`- ${countLine}`);
  lines.push(`- Signatures: ${report.signatureCount}`);
  lines.push(`- Last signature covers entire file: ${yesNo(report.lastSignatureCoversFile)}`);
  lines.push(`- DSS present: ${yesNo(report.hasDss)}`);
  if (report.signaturesWithLaterChanges.length > 0) {
    lines.push('', '## Changes after signing');
    for (const s of report.signaturesWithLaterChanges) {
      lines.push(
        `- ${s.fieldName ?? '(unnamed)'}: ${s.bytesAfterSignedRange} byte(s) added after signed range`,
      );
    }
  }
  if (report.certification) {
    const c = report.certification;
    lines.push('', '## Certification (DocMDP)');
    lines.push(`- Field: ${c.fieldName ?? '(unnamed)'}`);
    lines.push(`- Permission: ${c.permission} — ${c.permissionDescription}`);
    // 🔴 Print the three-valued assessment, not the boolean. `indeterminate`
    // collapses to "no" in the boolean, and "we could not tell" reported as
    // "not violated" is exactly the failure this section had before 0.14.0.
    const label =
      c.violationAssessment === 'violated'
        ? '**yes**'
        : c.violationAssessment === 'indeterminate'
          ? '**not determined** (could not be checked — this is not a pass)'
          : 'no';
    lines.push(`- Violated by later changes: ${label}`);
    lines.push(`  - ${c.assessmentReason}`);
    if (c.laterChangesAppearLtvOnly) {
      lines.push(
        '- Later changes appear to be DSS/document-timestamp updates (permitted by ISO 32000-2 §12.8.2.2)',
      );
    }
  }
  if (report.revisions && report.revisions.length > 1) {
    lines.push('', '## Revisions (object-level)');
    lines.push(...truncationLine('Revisions listed (newest first)', report.revisionsTruncated));
    lines.push(
      'Incremental updates are legal in PDF (ISO 32000-2 §7.5.6). The objects below say **what to review**, not that anything is wrong.',
    );
    for (const revision of report.revisions) {
      const after =
        revision.afterSignatures.length > 0
          ? ` — appended after ${revision.afterSignatures
              .map((name) => name ?? '(unnamed)')
              .join(', ')}`
          : '';
      lines.push(
        '',
        `### Revision ${revision.index} (xref at ${revision.xrefOffset}, ${revision.xrefKind})${after}`,
      );
      if (revision.changes === null) {
        lines.push('- Original revision — nothing older to compare against');
        continue;
      }
      if (revision.changes.length === 0) {
        lines.push('- No object changes declared');
        continue;
      }
      for (const change of revision.changes) {
        lines.push(`- ${formatObjectChange(change)}`);
      }
    }
  }
  if (report.objectChangesAfterLastSignature.length > 0) {
    const content = report.objectChangesAfterLastSignature.filter((c) => !c.bookkeeping);
    lines.push('', '## Objects written after the last signed range');
    lines.push(
      `- ${report.objectChangesAfterLastSignature.length} object(s), of which ${content.length} are not cross-reference/object-stream bookkeeping`,
    );
    for (const change of content) lines.push(`- ${formatObjectChange(change)}`);
  }
  if (report.notes.length > 0) {
    lines.push('', '## Notes');
    for (const note of report.notes) lines.push(`- ${note}`);
  }
  return lines.join('\n');
}

function formatObjectChange(change: RevisionObjectChange): string {
  const parts = [`obj ${change.objectNumber} ${change.generation}: ${change.change}`];
  if (change.role) parts.push(change.role);
  else if (change.inObjectStream) parts.push('inside an object stream (type not read)');
  else parts.push('type not determined');
  if (change.bookkeeping) parts.push('bookkeeping');
  return parts.join(' — ');
}

interface PolicyReportForFormat {
  scope: ReadingScope;
  profile: string;
  verdict: string;
  firedRules: { ruleId: string; verdict: string; reason: string }[];
  advisories: string[];
  notes: string[];
  facts: {
    signatureCount: number;
    signatures: {
      fieldName: string | null;
      verdict: string;
      trust: string;
      revocation: string | null;
      isDocumentTimestamp: boolean;
    }[];
    signaturesTruncated: Truncation | null;
    revisionCount: number;
    incrementalUpdateCount: number;
    lastSignatureCoversFile: boolean | null;
    signaturesWithLaterChanges: { fieldName: string | null; bytesAfterSignedRange: number }[];
    certification: {
      permission: number;
      violatedByLaterChanges: boolean;
      violationAssessment: DocMdpAssessment;
      assessmentReason: string;
    } | null;
    hasDss: boolean;
    padesLevels: { fieldName: string | null; level: string | null; normativeBasis?: string }[];
    conformance: { flavour: string; engine: string; compliant: boolean | null } | null;
  };
}

export function formatPolicyReport(report: PolicyReportForFormat): string {
  const lines: string[] = ['# Trust Policy Evaluation', ''];
  lines.push(...formatReadingScope(report.scope));
  lines.push(`- Profile: ${report.profile}`);
  lines.push(`- Verdict: **${report.verdict}**`);
  lines.push(
    `- Signatures: ${report.facts.signatureCount} (revisions: ${report.facts.revisionCount}, incremental updates: ${report.facts.incrementalUpdateCount}, DSS: ${yesNo(report.facts.hasDss)})`,
  );
  if (report.firedRules.length > 0) {
    lines.push('', '## Fired rules');
    for (const r of report.firedRules) {
      lines.push(`- **${r.ruleId}** → ${r.verdict}`);
      lines.push(`  - ${r.reason}`);
    }
  } else {
    lines.push('', 'No rules fired — every positive condition for trust_and_use is satisfied.');
  }
  if (report.facts.signatures.length > 0) {
    lines.push('', '## Signature facts');
    lines.push(
      ...truncationLine(
        'Signatures listed (the verdict covers all)',
        report.facts.signaturesTruncated,
      ),
    );
    for (const s of report.facts.signatures) {
      const kind = s.isDocumentTimestamp ? ' (document timestamp)' : '';
      lines.push(
        `- ${s.fieldName ?? '(unnamed)'}${kind}: verdict=${s.verdict}, trust=${s.trust}, revocation=${s.revocation ?? 'n/a'}`,
      );
    }
  }
  if (report.facts.padesLevels.some((p) => p.level)) {
    lines.push('', '## PAdES levels (observed from structure — not a conformance verdict)');
    for (const p of report.facts.padesLevels) {
      if (p.level) lines.push(`- ${p.fieldName ?? '(unnamed)'}: ${p.level}`);
    }
  }
  if (report.facts.signaturesWithLaterChanges.length > 0) {
    lines.push('', '## Post-signing changes');
    lines.push(
      `- Last signature covers entire file: ${yesNo(report.facts.lastSignatureCoversFile)}`,
    );
    for (const c of report.facts.signaturesWithLaterChanges) {
      lines.push(
        `- ${c.fieldName ?? '(unnamed)'}: ${c.bytesAfterSignedRange} byte(s) added after signed range`,
      );
    }
  }
  if (report.facts.conformance) {
    const c = report.facts.conformance;
    lines.push('', '## Long-term preservation');
    lines.push(
      `- ${c.flavour} (engine: ${c.engine}): ${c.compliant === true ? 'COMPLIANT' : c.compliant === false ? 'NOT COMPLIANT' : 'no violations in checked subset (not a certification)'}`,
    );
  }
  if (report.advisories.length > 0) {
    lines.push('', '## Advisories (do not affect the verdict)');
    for (const a of report.advisories) lines.push(`- ${a}`);
  }
  if (report.notes.length > 0) {
    lines.push('', '## Notes');
    for (const note of report.notes) lines.push(`- ${note}`);
  }
  return lines.join('\n');
}

export function formatPadesReports(result: PadesLevelResult): string {
  const reports = result.levels;
  const scope = formatReadingScope(result.scope);
  if (reports.length === 0) {
    return [
      '# PAdES Level Detection',
      '',
      ...scope,
      '',
      'No (non-timestamp) signatures found in this document.',
    ].join('\n');
  }
  // T3（規範なし）であることを表の外・冒頭で述べる。level だけを抜き出して
  // 「PAdES 準拠」と書かれるのを防ぐのが目的（Issue #9 / `specs/09 §2`）。
  const lines: string[] = [
    '# PAdES Level Detection',
    '',
    '> **Observation, not a conformance verdict.** ETSI EN 319 142 is not in this corpus and there is',
    '> no third-party validator for it, so what follows is which baseline the *structure* matches —',
    '> read as evidence, and do not restate it as "conforms to PAdES".',
    ...truncationLine('Signatures examined', result.levelsTruncated),
    '',
  ];
  lines.push(...scope, '');
  reports.forEach((r, i) => {
    lines.push(`## ${i + 1}. ${r.fieldName ?? '(unnamed field)'}`);
    lines.push('');
    lines.push(
      `- PAdES: ${yesNo(r.isPades)}${r.level ? ` — structure matches **${r.level}**` : ''}`,
    );
    lines.push(`- Normative basis: **${r.normativeBasis}** (no normative text available)`);
    lines.push(`- SubFilter: ${r.subFilter ?? '(none)'}`);
    lines.push(
      `- Evidence: signature timestamp=${yesNo(r.evidence.hasSignatureTimestamp)}, DSS=${yesNo(r.evidence.hasDss)}, VRI=${yesNo(r.evidence.hasVri)}, document timestamp=${yesNo(r.evidence.hasDocumentTimestamp)}`,
    );
    if (r.ltv) {
      lines.push(
        `- LTV data: ${r.ltv.dssCertCount} cert(s), ${r.ltv.dssOcspCount} OCSP(s), ${r.ltv.dssCrlCount} CRL(s) in DSS — covers signer: ${yesNo(r.ltv.revocationDataCoversSigner)}`,
      );
    }
    for (const note of r.notes) lines.push(`- Note: ${note}`);
    lines.push('');
  });
  return lines.join('\n');
}

export function formatConformanceValidation(
  report: import('../services/conformance-validation.js').ConformanceValidationReport,
): string {
  const standard = report.flavour.startsWith('PDF/UA') ? 'PDF/UA' : 'PDF/A';
  const lines: string[] = [`# ${standard} Conformance Validation`, ''];
  lines.push(...formatReadingScope(report.scope));
  lines.push(`- Flavour: ${report.flavour}`);
  lines.push(`- Engine: ${report.engine}`);
  // Before the numbers, not after them. A reader who meets "24 checked, 24
  // passed" first has already formed a verdict by the time a note at the bottom
  // says the authoritative validator never ran.
  //
  // 🔴 **The performed case gets the same placement.** It used to reach the
  // reader only through `## Notes` at the bottom, so the build that produced
  // "146 checked, 146 passed" arrived after the numbers it qualifies — the
  // footnote position this field exists to avoid. The note is moved rather than
  // duplicated: `veraPdfNote` builds the same string, so it is dropped from the
  // Notes list below.
  const performedNote = veraPdfNote(report.authoritativeValidation);
  if (report.authoritativeValidation.performed) {
    lines.push(`- ${performedNote}`);
  } else {
    lines.push(
      `- **Authoritative validation (veraPDF): NOT PERFORMED** — ${report.authoritativeValidation.detail} The subset below can disprove conformance but cannot certify it.`,
    );
  }
  const compliantLabel =
    report.compliant === true
      ? '**COMPLIANT**'
      : report.compliant === false
        ? '**NOT COMPLIANT**'
        : '**NO VIOLATIONS DETECTED** (subset check — not a certification)';
  lines.push(`- Result: ${compliantLabel}`);
  const skipped = report.skippedRules
    ? `, ${report.skippedRules} NOT checked (encrypted — supply password)`
    : '';
  lines.push(
    `- Rules: ${report.checkedRules} checked, ${report.passedRules} passed, ${report.failedRules} failed${skipped}`,
  );
  if (report.violations.length > 0) {
    lines.push('', '## Violations');
    lines.push(
      ...truncationLine('Violations listed (counts above cover all)', report.violationsTruncated),
    );
    for (const v of report.violations) {
      const sev = v.severity ? `[${v.severity}] ` : '';
      lines.push(`- ${sev}**${v.ruleId}** (${v.clause}): ${v.description}`);
      if (v.detail) lines.push(`  - ${v.detail}`);
    }
  }
  // 上へ移した注記は繰り返さない（同じ文が 2 度出ると、どちらが本文か決められない）
  const rest = report.notes.filter((note) => note !== performedNote);
  if (rest.length > 0) {
    lines.push('', '## Notes');
    for (const note of rest) lines.push(`- ${note}`);
  }
  return lines.join('\n');
}

/**
 * validate_clauses の markdown。
 *
 * **判定の由来（どの版のテーブルか）を見出し直下に置く。** 収録制約が増えれば結果も変わりうるので、
 * 版が分からないレポートは再現できない。PAdES の注記で学んだとおり、読み手が数字を見る**前**に
 * 前提が目に入る位置に置くこと。
 */
export function formatClauseValidation(
  report: import('../services/clause-validation.js').ClauseValidationReport,
): string {
  const lines: string[] = ['# ISO 32000 Clause Constraints', ''];
  lines.push(...formatReadingScope(report.scope));
  lines.push(
    `- Decided by: @shuji-bonji/pdf-constraints ${report.constraintsVersion} ` +
      `(${report.tables.map((t) => `${t.name} v${t.version}`).join(', ')})`,
  );
  // 射程を数字より先に置く。「違反なし」と「そこを見ていない」を読み手が取り違えないため。
  //
  // 🔴 **1 つ上の行と別の名前にしてある。** どちらも「どこまで見たか」だが、測っている
  // ものが違う —— 上は verify がこの文書をどこまで読めたか（`ReadingScope`）、
  // ここは pdf-constraints が制約を当てるときに観測できた範囲である。0.22.0 まで
  // どちらも `Scope of this reading` と名乗っていて、2,929 検体でこの 2 行が並んでいた。
  // 数字が食い違ったとき、読み手はどちらを読めばいいか分からない。
  const obs = report.observation;
  lines.push(
    `- Scope pdf-constraints observed: revision chain ${obs.xrefChain}, ${obs.objects} object(s), ` +
      `${obs.pagesReached ? `${obs.pages} page(s) reached` : '**page tree NOT reached**'}`,
  );
  lines.push(`- Subjects examined: ${report.subjects}`);
  // 🔴 **`checked` が 2 つを指す。** 表に載っている制約と、実際に当てられた制約である。
  // 26 件のうち 26 件が `needs_external_fact` のとき、当てられた制約は 0 件なので、
  // `no failures in the constraints checked` は何も言っていない。2 つを分けて、
  // 1 件も判定していないときは「判定していない」と書く。
  //
  // 出自: 2026-08-30、鍵が導けない暗号化文書（`ua-enc-aesv3-pw.pdf` /
  // `ua-enc-aesv2-pw.pdf`）。コーパス 2,953 件のうち該当は 2 件。
  // 一部だけ未判定の 848 件では `no failures ..., N not decided` のままでよい。
  const decided = report.results.length - report.notDecided;
  const verdict =
    report.violations > 0
      ? `**${report.violations} failure(s)**`
      : decided > 0
        ? '**no failures in the constraints checked**'
        : '**no constraint was decided**';
  const undecidedTail = report.notDecided > 0 ? `, ${report.notDecided} not decided` : '';
  lines.push(`- Result: ${verdict}${undecidedTail}`);

  const failed = report.results.filter((r) => r.status === 'fail');
  if (failed.length > 0) {
    lines.push('', '## Failures');
    lines.push(
      ...truncationLine('Results listed (counts above cover all)', report.resultsTruncated),
    );
    for (const result of failed) {
      for (const failure of result.failures ?? []) {
        // 主語が processor の条文は「違反」と断定しない（specs/18 §1）
        const kind = failure.traceOnly ? 'Trace of a violation' : 'Violation';
        lines.push(
          `- **${result.constraintId}** [${failure.clauses.join(', ')}] — ${result.target}`,
          `  - ${kind}: ${failure.message}`,
          `  - Evidence: \`${failure.fact}\` = ${JSON.stringify(failure.actual)}`,
        );
        // 判定は変えないが、これが無いと誤読される文脈。verdict と混ぜないよう別行に置く
        if (failure.note) lines.push(`  - Context: ${failure.note}`);
      }
    }
  }

  const undecided = report.results.filter((r) => r.status === 'needs_external_fact');
  if (undecided.length > 0) {
    lines.push('', '## Not decided');
    for (const result of undecided) {
      lines.push(
        `- **${result.constraintId}** — ${result.target}: needs \`${result.missing}\` ` +
          '(neither passed nor failed)',
      );
    }
  }

  lines.push('', '## Notes');
  for (const note of report.notes) lines.push(`- ${note}`);
  return lines.join('\n');
}

export function formatConformanceReport(report: ConformanceReport): string {
  const lines: string[] = ['# Conformance Declaration', ''];
  lines.push(...formatReadingScope(report.scope));
  lines.push(`- PDF version: ${report.pdfVersion ?? 'unknown'}`);
  lines.push(`- XMP metadata: ${yesNo(report.hasXmp)}`);
  lines.push(
    `- PDF/A declaration: ${report.pdfA ? `PDF/A-${report.pdfA.part}${report.pdfA.conformance ? report.pdfA.conformance.toLowerCase() : ''}` : 'none'}`,
  );
  lines.push(`- PDF/UA declaration: ${report.pdfUa ? `PDF/UA-${report.pdfUa.part}` : 'none'}`);
  lines.push('', '## Notes');
  for (const note of report.notes) lines.push(`- ${note}`);
  return lines.join('\n');
}
