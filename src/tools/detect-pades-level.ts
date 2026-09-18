/**
 * detect_pades_level - PAdES baseline level detection (B-B / B-T / B-LT / B-LTA).
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { toReadingScope } from '@normativepdf/recover';
import { MAX_SIGNATURES, ResponseFormat } from '../constants.js';
import { type PdfToolInput, PdfToolInputSchema } from '../schemas/common.js';
import { parsePdf } from '../services/pdf-parser.js';
import { detectPadesLevels } from '../services/verification-service.js';
import type { PadesLevelResult } from '../types.js';
import { handleStructuredError } from '../utils/error-handler.js';
import { formatPadesReports, renderBody } from '../utils/formatter.js';
import { capArray } from '../utils/truncation.js';

export function registerDetectPadesLevel(server: McpServer): void {
  server.registerTool(
    'detect_pades_level',
    {
      title: 'Detect PAdES Baseline Level',
      description: `Observe which PAdES baseline level (ETSI EN 319 142) the structure of each signature matches.

**This is an observation, not a conformance verdict.** ETSI EN 319 142 is not in this family's spec corpus, and unlike PDF/A there is no third-party validator to delegate to — so the result says "the structure matches B-LT", never "conforms to PAdES B-LT". Every report carries normativeBasis: "T3" to make that explicit.

Detection is structural: B-B (CAdES signature), B-T (+ RFC 3161 signature timestamp), B-LT (+ DSS with validation data), B-LTA (+ document timestamp). Legacy adbe.pkcs7.detached signatures are reported as non-PAdES.

Args:
  - file_path (string): Absolute path to a local PDF file
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  An object of the form { scope, levels: [...] }. The top level changed from an array to an object in v0.21.0 - read .levels for the list.

  Size (v0.29.0): at most 32 signatures are listed; levelsTruncated = { returned, total } says when the list was cut. JSON is never cut by length.

  Every report begins with a "scope" object - how far the reading got, not a verdict: whether the cross-reference chain could be walked to the end (chainStop), whether this tool had to rebuild the cross-reference table itself (reconstructed - when true, the table is this tool's reconstruction and not the one the file carries), how many objects and sections were read, and whether an encrypted document could be opened. Read it before the verdict: "no violations" over a rebuilt table is not the same statement as "no violations" over the file's own table.

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
        // 🔴 0.21.0 で最上位を配列から辞書にした（verify_signatures と同じ理由）。
        // v0.29.0 (#18): list capped at MAX_SIGNATURES (document timestamps are
        // not listed by this tool, so the cap is applied to the listed levels)
        const capped = capArray(await detectPadesLevels(parsed), MAX_SIGNATURES);
        const result: PadesLevelResult = {
          scope: toReadingScope(parsed.scope),
          levels: capped.items,
          levelsTruncated: capped.truncated,
        };
        const text = renderBody(params.response_format === ResponseFormat.JSON, result, () =>
          formatPadesReports(result),
        );
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
