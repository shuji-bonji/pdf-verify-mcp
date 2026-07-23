/**
 * evaluate_policy — deterministic 4-value trust verdict (Issue #4, v0.7.0).
 *
 * Runs the verification pipeline internally (verify_signatures,
 * verify_integrity, detect_pades_level, and — profile permitting —
 * validate_conformance) and folds the facts through the rule engine in
 * services/policy-engine.ts. The judge is code; the narrative is the LLM.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ResponseFormat, RevocationMode, ValidationEngine } from '../constants.js';
import { PdfToolInputSchema } from '../schemas/common.js';
import { extractPdfaId } from '../services/conformance.js';
import type { ConformanceValidationReport } from '../services/conformance-validation.js';
import { validateConformance } from '../services/conformance-validation.js';
import { parsePdf } from '../services/pdf-parser.js';
import {
  evaluatePolicy,
  POLICY_PROFILES,
  type PolicyProfileId,
} from '../services/policy-engine.js';
import {
  analyzeIntegrity,
  detectPadesLevels,
  verifySignatures,
} from '../services/verification-service.js';
import { handleStructuredError } from '../utils/error-handler.js';
import { formatPolicyReport, truncateIfNeeded } from '../utils/formatter.js';
import { logger } from '../utils/logger.js';

const CONTEXT = 'evaluate-policy';

const PROFILE_IDS = Object.keys(POLICY_PROFILES) as [PolicyProfileId, ...PolicyProfileId[]];

const EvaluatePolicySchema = {
  ...PdfToolInputSchema,
  profile: z
    .enum(PROFILE_IDS)
    .default('general')
    .describe(
      'Judgment profile: "general" (default thresholds), "contract" (signature required, identity-focused), "financial" (long-term preservation checks), "legal", "medical" (most conservative; caution escalates to review), "government" (long-term checks, unsigned tolerated).',
    ),
  trust_anchors: z
    .array(z.string())
    .optional()
    .describe(
      'Absolute paths to trust anchor certificates (PEM or DER). Merged with the PDF_VERIFY_TRUST_ANCHORS environment variable. Without anchors, valid signatures are capped at use_with_caution (identity not evaluated).',
    ),
  check_revocation: z
    .nativeEnum(RevocationMode)
    .default(RevocationMode.EMBEDDED)
    .describe(
      'Revocation checking: "none", "embedded" (default), or "online" (queries OCSP/CRL endpoints over HTTP).',
    ),
  password: z
    .string()
    .optional()
    .describe(
      'Password for an encrypted PDF. Omit for permission-encrypted PDFs (an empty user password is tried automatically).',
    ),
};

type EvaluatePolicyInput = {
  file_path: string;
  response_format: ResponseFormat;
  profile: PolicyProfileId;
  trust_anchors?: string[];
  check_revocation: RevocationMode;
  password?: string;
};

export function registerEvaluatePolicy(server: McpServer): void {
  server.registerTool(
    'evaluate_policy',
    {
      title: 'Evaluate Trust Policy (deterministic verdict)',
      description: `Produce a deterministic 4-value trust verdict (trust_and_use / use_with_caution / human_review_required / reject) for a PDF.

Runs verify_signatures, verify_integrity and detect_pades_level internally (plus validate_conformance for long-term-preservation profiles) and folds the facts through a fixed rule table — the same facts and profile always yield the same verdict. The verdict is decided entirely by code; use the returned firedRules/advisories to explain the outcome, never to override it. It judges authenticity and integrity only, never the truth of the document's content.

Args:
  - file_path (string): Absolute path to a local PDF file
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')
  - profile ('general' | 'contract' | 'financial' | 'legal' | 'medical' | 'government'): Judgment profile (default: 'general')
  - trust_anchors (string[], optional): Trust anchor certificate paths. Without them, signer identity stays not_evaluated and the verdict is capped at use_with_caution
  - check_revocation ('none' | 'embedded' | 'online'): Revocation mode (default: 'embedded')
  - password (string, optional): Password for an encrypted PDF

Returns:
  verdict, firedRules (rule IDs with per-rule verdict and reason), advisories (recommendations that do not affect the verdict), and the underlying facts summary.

Examples:
  - Gate incoming invoices before filing them (profile: financial)
  - Decide whether a countersigned contract can be relied on (profile: contract, with the counterparty CA as trust anchor)
  - Batch-audit a folder of received PDFs with a reproducible, model-independent verdict`,
      inputSchema: EvaluatePolicySchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: EvaluatePolicyInput) => {
      try {
        const parsed = await parsePdf(params.file_path, { password: params.password });
        const profile = POLICY_PROFILES[params.profile];

        const signatures = await verifySignatures(parsed, {
          trustAnchorPaths: params.trust_anchors,
          revocationMode: params.check_revocation,
        });
        const integrity = analyzeIntegrity(parsed);
        const pades = await detectPadesLevels(parsed);

        let conformance: ConformanceValidationReport | null = null;
        if (profile.longTermChecks) {
          try {
            // Long-term preservation means PDF/A (ISO 19005). Without an
            // explicit flavour, a document declaring only PDF/UA would be
            // auto-routed to accessibility validation — force the PDF/A
            // baseline unless the document declares a PDF/A flavour itself.
            const declaresPdfa = extractPdfaId(parsed.xmpMetadata) !== null;
            conformance = await validateConformance(parsed, params.file_path, {
              engine: ValidationEngine.AUTO,
              password: params.password,
              ...(declaresPdfa ? {} : { flavour: 'pdfa-2b' }),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug(CONTEXT, `conformance check failed: ${message}`);
          }
        }

        const evaluation = evaluatePolicy(
          { signatures, integrity, pades, conformance },
          params.profile,
        );
        if (profile.longTermChecks && conformance === null) {
          evaluation.advisories.push(
            'Long-term preservation check (PDF/A conformance) could not be completed — record it as "not performed", not as passed',
          );
        }

        const report = {
          ...evaluation,
          facts: {
            signatureCount: signatures.filter((s) => !s.isDocumentTimestamp).length,
            signatures: signatures.map((s) => ({
              fieldName: s.fieldName,
              verdict: s.verdict,
              trust: s.trust.status,
              revocation: s.revocation?.status ?? null,
              isDocumentTimestamp: s.isDocumentTimestamp,
            })),
            revisionCount: integrity.revisionCount,
            incrementalUpdateCount: integrity.incrementalUpdateCount,
            lastSignatureCoversFile: integrity.lastSignatureCoversFile,
            signaturesWithLaterChanges: integrity.signaturesWithLaterChanges,
            certification: integrity.certification,
            hasDss: integrity.hasDss,
            padesLevels: pades.map((p) => ({ fieldName: p.fieldName, level: p.level })),
            conformance: conformance
              ? {
                  flavour: conformance.flavour,
                  engine: conformance.engine,
                  compliant: conformance.compliant,
                }
              : null,
          },
        };

        const raw =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(report, null, 2)
            : formatPolicyReport(report);
        const { text } = truncateIfNeeded(raw);
        return { content: [{ type: 'text' as const, text }] };
      } catch (error) {
        const err = handleStructuredError(error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(err, null, 2) }],
          isError: true,
        };
      }
    },
  );
}
