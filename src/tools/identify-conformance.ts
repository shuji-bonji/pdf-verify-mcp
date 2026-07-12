/**
 * identify_conformance - PDF/A / PDF/UA declaration identification.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResponseFormat } from '../constants.js';
import { type PdfToolInput, PdfToolInputSchema } from '../schemas/common.js';
import { identifyConformance } from '../services/conformance.js';
import { parsePdf } from '../services/pdf-parser.js';
import { handleStructuredError } from '../utils/error-handler.js';
import { formatConformanceReport, truncateIfNeeded } from '../utils/formatter.js';

export function registerIdentifyConformance(server: McpServer): void {
  server.registerTool(
    'identify_conformance',
    {
      title: 'Identify PDF/A / PDF/UA Declarations',
      description: `Identify declared PDF/A (pdfaid) and PDF/UA (pdfuaid) conformance in a PDF's XMP metadata.

Args:
  - file_path (string): Absolute path to a local PDF file
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  Declared PDF/A part/conformance level and PDF/UA part, plus the PDF version.

IMPORTANT: This is identification of DECLARED conformance only. Full conformance validation (veraPDF-level rule checking) is out of scope in v0.1 — a declaration does not guarantee actual conformance.

Examples:
  - Check whether a document claims PDF/A-2b before archiving
  - Detect PDF/UA declarations for accessibility workflows`,
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
        const report = identifyConformance(parsed);
        const raw =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(report, null, 2)
            : formatConformanceReport(report);
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
