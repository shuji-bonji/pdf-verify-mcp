/**
 * verify_integrity - Tamper detection via incremental update analysis.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResponseFormat } from '../constants.js';
import { type PdfToolInput, PdfToolInputSchema } from '../schemas/common.js';
import { parsePdf } from '../services/pdf-parser.js';
import { analyzeIntegrity } from '../services/verification-service.js';
import { handleStructuredError } from '../utils/error-handler.js';
import { formatIntegrityReport, truncateIfNeeded } from '../utils/formatter.js';

export function registerVerifyIntegrity(server: McpServer): void {
  server.registerTool(
    'verify_integrity',
    {
      title: 'Verify PDF Integrity (tamper detection)',
      description: `Analyze a PDF for modifications after signing.

Reports: number of revisions (incremental updates), whether bytes were added after each signature's signed range, whether the last signature covers the entire file, DocMDP certification permissions and violations, and DSS presence.

Args:
  - file_path (string): Absolute path to a local PDF file
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  Integrity report. Note that incremental updates after signing are legal in PDF (adding signatures, DSS/LTV data) — findings indicate what to review, not automatically tampering.

Examples:
  - Check whether a signed document was modified after signing
  - Verify a certified (DocMDP) document respects its declared permissions`,
      inputSchema: PdfToolInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: PdfToolInput) => {
      try {
        const parsed = await parsePdf(params.file_path);
        const report = analyzeIntegrity(parsed);
        const raw =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(report, null, 2)
            : formatIntegrityReport(report);
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
