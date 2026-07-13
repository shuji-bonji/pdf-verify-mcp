/**
 * detect_pades_level - PAdES baseline level detection (B-B / B-T / B-LT / B-LTA).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResponseFormat } from '../constants.js';
import { type PdfToolInput, PdfToolInputSchema } from '../schemas/common.js';
import { parsePdf } from '../services/pdf-parser.js';
import { detectPadesLevels } from '../services/verification-service.js';
import { handleStructuredError } from '../utils/error-handler.js';
import { formatPadesReports, truncateIfNeeded } from '../utils/formatter.js';

export function registerDetectPadesLevel(server: McpServer): void {
  server.registerTool(
    'detect_pades_level',
    {
      title: 'Detect PAdES Baseline Level',
      description: `Determine the PAdES baseline level (ETSI EN 319 142) of each signature in a PDF.

Detection is structural: B-B (CAdES signature), B-T (+ RFC 3161 signature timestamp), B-LT (+ DSS with validation data), B-LTA (+ document timestamp). Legacy adbe.pkcs7.detached signatures are reported as non-PAdES.

Args:
  - file_path (string): Absolute path to a local PDF file
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  Per-signature level with evidence (signature timestamp, DSS, VRI, document timestamp presence).

Note: B-LT / B-LTA additionally require that the DSS revocation data actually covers the signer certificate (content-level LTV validation); otherwise the level is capped at B-T.

Examples:
  - Check if a signature is long-term validation (LTV) enabled
  - Audit whether archived contracts meet B-LTA requirements`,
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
        const reports = await detectPadesLevels(parsed);
        const raw =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(reports, null, 2)
            : formatPadesReports(reports);
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
