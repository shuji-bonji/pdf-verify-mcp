/**
 * Markdown formatters for tool responses.
 */

import { CHARACTER_LIMIT } from '../constants.js';
import type {
  CmsVerificationResult,
  ConformanceReport,
  IntegrityReport,
  PadesLevelReport,
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
  const lines: string[] = ['# PAdES Level Detection', ''];
  reports.forEach((r, i) => {
    lines.push(`## ${i + 1}. ${r.fieldName ?? '(unnamed field)'}`);
    lines.push('');
    lines.push(`- PAdES: ${yesNo(r.isPades)}${r.level ? ` — level **${r.level}**` : ''}`);
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
  lines.push(
    `- Rules: ${report.checkedRules} checked, ${report.passedRules} passed, ${report.failedRules} failed`,
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
