/**
 * Markdown formatters for tool responses.
 */

import { CHARACTER_LIMIT } from '../constants.js';
import type {
  CmsVerificationResult,
  ConformanceReport,
  IntegrityReport,
  PadesLevelReport,
  RevisionObjectChange,
  SignatureVerificationReport,
} from '../types.js';

export function truncateIfNeeded(text: string): { text: string; truncated: boolean } {
  if (text.length <= CHARACTER_LIMIT) return { text, truncated: false };
  return {
    text: `${text.slice(0, CHARACTER_LIMIT)}\n\n…(truncated)`,
    truncated: true,
  };
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

export function formatSignatureReports(reports: SignatureVerificationReport[]): string {
  if (reports.length === 0) {
    return '# Signature Verification\n\nNo signatures found in this document.';
  }
  const lines: string[] = ['# Signature Verification', ''];
  lines.push(`Signatures found: ${reports.length}`, '');
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
    if (r.revocation) {
      lines.push(
        `- Revocation: **${r.revocation.status}**${r.revocation.source ? ` (${r.revocation.source})` : ''}${r.revocation.detail ? ` — ${r.revocation.detail}` : ''}`,
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

export function formatIntegrityReport(report: IntegrityReport): string {
  const lines: string[] = ['# Integrity Analysis', ''];
  lines.push(`- File size: ${report.fileSize} bytes`);
  lines.push(
    `- Revisions: ${report.revisionCount} (incremental updates: ${report.incrementalUpdateCount})`,
  );
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
    lines.push(`- Violated by later changes: **${yesNo(c.violatedByLaterChanges)}**`);
    if (c.laterChangesAppearLtvOnly) {
      lines.push(
        '- Later changes appear to be DSS/document-timestamp updates (permitted by ISO 32000-2 §12.8.2.2)',
      );
    }
  }
  if (report.revisions && report.revisions.length > 1) {
    lines.push('', '## Revisions (object-level)');
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
    revisionCount: number;
    incrementalUpdateCount: number;
    lastSignatureCoversFile: boolean | null;
    signaturesWithLaterChanges: { fieldName: string | null; bytesAfterSignedRange: number }[];
    certification: { permission: number; violatedByLaterChanges: boolean } | null;
    hasDss: boolean;
    padesLevels: { fieldName: string | null; level: string | null; normativeBasis?: string }[];
    conformance: { flavour: string; engine: string; compliant: boolean | null } | null;
  };
}

export function formatPolicyReport(report: PolicyReportForFormat): string {
  const lines: string[] = ['# Trust Policy Evaluation', ''];
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

export function formatPadesReports(reports: PadesLevelReport[]): string {
  if (reports.length === 0) {
    return '# PAdES Level Detection\n\nNo (non-timestamp) signatures found in this document.';
  }
  // T3（規範なし）であることを表の外・冒頭で述べる。level だけを抜き出して
  // 「PAdES 準拠」と書かれるのを防ぐのが目的（Issue #9 / `specs/09 §2`）。
  const lines: string[] = [
    '# PAdES Level Detection',
    '',
    '> **Observation, not a conformance verdict.** ETSI EN 319 142 is not in this corpus and there is',
    '> no third-party validator for it, so what follows is which baseline the *structure* matches —',
    '> read as evidence, and do not restate it as "conforms to PAdES".',
    '',
  ];
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
  lines.push(`- Flavour: ${report.flavour}`);
  lines.push(`- Engine: ${report.engine}`);
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
    for (const v of report.violations) {
      const sev = v.severity ? `[${v.severity}] ` : '';
      lines.push(`- ${sev}**${v.ruleId}** (${v.clause}): ${v.description}`);
      if (v.detail) lines.push(`  - ${v.detail}`);
    }
  }
  if (report.notes.length > 0) {
    lines.push('', '## Notes');
    for (const note of report.notes) lines.push(`- ${note}`);
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
  lines.push(
    `- Decided by: @shuji-bonji/pdf-constraints ${report.constraintsVersion} ` +
      `(${report.tables.map((t) => `${t.name} v${t.version}`).join(', ')})`,
  );
  lines.push(`- Subjects examined: ${report.subjects}`);
  lines.push(
    `- Result: ${report.violations > 0 ? `**${report.violations} failure(s)**` : '**no failures in the constraints checked**'}` +
      (report.notDecided > 0 ? `, ${report.notDecided} not decided` : ''),
  );

  const failed = report.results.filter((r) => r.status === 'fail');
  if (failed.length > 0) {
    lines.push('', '## Failures');
    for (const result of failed) {
      for (const failure of result.failures ?? []) {
        // 主語が processor の条文は「違反」と断定しない（specs/18 §1）
        const kind = failure.traceOnly ? 'Trace of a violation' : 'Violation';
        lines.push(
          `- **${result.constraintId}** [${failure.clauses.join(', ')}] — ${result.target}`,
          `  - ${kind}: ${failure.message}`,
          `  - Evidence: \`${failure.fact}\` = ${JSON.stringify(failure.actual)}`,
        );
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
