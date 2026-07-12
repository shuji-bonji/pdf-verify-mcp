/**
 * validate_conformance - PDF/A conformance validation (hybrid engine).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ResponseFormat, ValidationEngine } from '../constants.js';
import { PdfToolInputSchema } from '../schemas/common.js';
import { validateConformance } from '../services/conformance-validation.js';
import { parsePdf } from '../services/pdf-parser.js';
import { handleStructuredError } from '../utils/error-handler.js';
import { formatConformanceValidation, truncateIfNeeded } from '../utils/formatter.js';

const ValidateConformanceSchema = {
  ...PdfToolInputSchema,
  flavour: z
    .string()
    .optional()
    .describe(
      'PDF/A flavour to validate against: "pdfa-1b", "pdfa-1a", "pdfa-2b", "pdfa-2u", "pdfa-3b", etc. Omit to use the document\'s XMP declaration (falls back to pdfa-2b).',
    ),
  engine: z
    .nativeEnum(ValidationEngine)
    .default(ValidationEngine.AUTO)
    .describe(
      'Validation engine: "auto" (veraPDF when installed, else native subset), "verapdf" (require veraPDF), "native" (built-in rule subset).',
    ),
};

type ValidateConformanceInput = {
  file_path: string;
  response_format: ResponseFormat;
  flavour?: string;
  engine: ValidationEngine;
};

export function registerValidateConformance(server: McpServer): void {
  server.registerTool(
    'validate_conformance',
    {
      title: 'Validate PDF/A Conformance',
      description: `Validate a PDF against a PDF/A flavour (ISO 19005).

Hybrid engine: when veraPDF is installed (PDF_VERIFY_VERAPDF env var or on PATH) validation is delegated to it for an authoritative result. Otherwise a built-in subset of ~15 high-value rules is checked natively (encryption, file ID, LZW, font embedding, JavaScript/prohibited actions, OutputIntent, transparency for A-1, XFA, and more).

Args:
  - file_path (string): Absolute path to a local PDF file
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')
  - flavour (string, optional): e.g. "pdfa-2b". Defaults to the XMP declaration (fallback: pdfa-2b)
  - engine ('auto' | 'verapdf' | 'native'): Engine selection (default: 'auto')

Returns:
  Per-rule results with ISO 19005 clause references. compliant is true/false for veraPDF; for the native engine, false means definitive violations were found and null means "no violations in the checked subset" (NOT certification).

Note: PDF/UA (accessibility) validation is out of scope — use pdf-reader-mcp's validate_tagged.

Examples:
  - Check whether a scanned archive PDF actually meets its declared PDF/A-2b
  - Find why a document fails PDF/A before submitting it to an archive system`,
      inputSchema: ValidateConformanceSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: ValidateConformanceInput) => {
      try {
        const parsed = await parsePdf(params.file_path);
        const report = await validateConformance(parsed, params.file_path, {
          flavour: params.flavour,
          engine: params.engine,
        });
        const raw =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(report, null, 2)
            : formatConformanceValidation(report);
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
