/**
 * validate_clauses — ISO 32000 本体条文（T1）の検査。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ResponseFormat } from '../constants.js';
import { PdfToolInputSchema } from '../schemas/common.js';
import { listClauseDomains, validateClauses } from '../services/clause-validation.js';
import { handleStructuredError } from '../utils/error-handler.js';
import { formatClauseValidation, truncateIfNeeded } from '../utils/formatter.js';

const ValidateClausesSchema = {
  ...PdfToolInputSchema,
  domains: z
    .array(z.string())
    .optional()
    .describe(
      `Constraint domains to apply. Omit to apply all bundled domains (${listClauseDomains().join(', ')}).`,
    ),
  given: z
    .record(z.union([z.boolean(), z.string(), z.number()]))
    .optional()
    .describe(
      'Facts that are NOT in the file but are needed to decide some clauses, e.g. { "isSubset": true }. A clause whose applicability depends on a missing fact is reported as needs_external_fact — it is never defaulted into a pass.',
    ),
};

type ValidateClausesInput = {
  file_path: string;
  response_format: ResponseFormat;
  domains?: string[];
  given?: Record<string, boolean | string | number>;
};

export function registerValidateClauses(server: McpServer): void {
  server.registerTool(
    'validate_clauses',
    {
      title: 'Check ISO 32000 Clause Constraints',
      description: `Check a PDF against constraints mapped from ISO 32000-1/-2 clauses — the body of the PDF specification itself, not PDF/A or PDF/UA.

This covers what veraPDF does not look at. veraPDF judges PDF/A and PDF/UA profiles; a document can pass those and still violate ISO 32000 (for example embedding a CFF font program under /FontFile2, which Table 124 forbids).

The mapping and its evaluation live in @shuji-bonji/pdf-constraints; this tool reports which version decided the result. Same file plus same given facts always produce the same result.

Bundled domains: ${listClauseDomains().join(', ')}

Args:
  - file_path (string): Absolute path to a local PDF file
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')
  - domains (string[], optional): Restrict to specific domains
  - given (object, optional): External facts, e.g. { "isSubset": true }

Returns:
  Per-constraint results with the clause IDs they come from. Four states:
  - pass — nothing in this constraint could be disproved
  - fail — disproved, with the fact and its measured value as evidence
  - not_applicable — the clause does not apply to this document
  - needs_external_fact — a fact outside the file was not supplied, so the constraint was not decided (never defaulted into a pass)

Because these are T1 clauses, a failure can be stated plainly and the clause ID quoted — retrieve the wording with pdf-spec-mcp's get_requirements. Failures marked as traces are different: the clause addresses the PDF *processor*, so the file only shows that someone broke it, not that the last writer did.

**A result with no failures is not proof of conformance** — only that nothing in the bundled constraints could be disproved.

Examples:
  - Find out why a viewer warns about a font that veraPDF considers fine
  - Check whether Info and XMP agree on the document dates (§14.3.4)
  - Verify a generated PDF before shipping it, beyond the PDF/A profile`,
      inputSchema: ValidateClausesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: ValidateClausesInput) => {
      try {
        const report = await validateClauses(params.file_path, {
          domains: params.domains,
          given: params.given,
        });
        const raw =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(report, null, 2)
            : formatClauseValidation(report);
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
