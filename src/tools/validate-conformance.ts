/**
 * validate_conformance - PDF/A conformance validation (hybrid engine).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ResponseFormat, ValidationEngine } from '../constants.js';
import { PdfToolInputSchema } from '../schemas/common.js';
import { validateConformance } from '../services/conformance-validation.js';
import { parsePdf } from '../services/pdf-parser.js';
import { PDFA_NATIVE_RULE_COUNT } from '../services/pdfa-validator.js';
import { PDFUA_NATIVE_RULE_COUNT } from '../services/pdfua-validator.js';
import { handleStructuredError } from '../utils/error-handler.js';
import { formatConformanceValidation, truncateIfNeeded } from '../utils/formatter.js';

const ValidateConformanceSchema = {
  ...PdfToolInputSchema,
  flavour: z
    .string()
    .optional()
    .describe(
      'Flavour to validate against. PDF/A: "pdfa-1b", "pdfa-1a", "pdfa-2b", "pdfa-2u", "pdfa-3b", etc. PDF/UA: "pdfua-1", "pdfua-2". Omit to use the document\'s XMP declaration (PDF/A takes precedence when both are declared; falls back to pdfa-2b).',
    ),
  engine: z
    .nativeEnum(ValidationEngine)
    .default(ValidationEngine.AUTO)
    .describe(
      'Validation engine: "auto" (veraPDF when installed, else native subset), "verapdf" (require veraPDF), "native" (built-in rule subset).',
    ),
  password: z
    .string()
    .optional()
    .describe(
      'Password for an encrypted PDF (PDF/UA validation only — the document is decrypted before checking structure-dependent rules). Omit for permission-encrypted PDFs (an empty user password is tried automatically).',
    ),
};

type ValidateConformanceInput = {
  file_path: string;
  response_format: ResponseFormat;
  flavour?: string;
  engine: ValidationEngine;
  password?: string;
};

export function registerValidateConformance(server: McpServer): void {
  server.registerTool(
    'validate_conformance',
    {
      title: 'Validate PDF/A and PDF/UA Conformance',
      description: `Validate a PDF against a PDF/A flavour (ISO 19005, archiving) or a PDF/UA flavour (ISO 14289, accessibility).

Hybrid engine: when veraPDF is installed (PDF_VERIFY_VERAPDF env var or on PATH) validation is delegated to it for an authoritative result. Otherwise a built-in rule subset is checked natively:
  - PDF/A (${PDFA_NATIVE_RULE_COUNT} rules): encryption, file ID, LZW, font embedding, JavaScript/prohibited actions, OutputIntent, transparency for A-1, XFA, and more
  - PDF/UA (${PDFUA_NATIVE_RULE_COUNT} rules): MarkInfo/Marked, StructTreeRoot, pdfuaid declaration, /Lang, DisplayDocTitle, document title, Figure /Alt, image tagging, heading hierarchy, table TH/TR, Link /Contents

Args:
  - file_path (string): Absolute path to a local PDF file
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')
  - flavour (string, optional): e.g. "pdfa-2b", "pdfua-1". Defaults to the XMP declaration (PDF/A wins when both are declared; fallback: pdfa-2b)
  - engine ('auto' | 'verapdf' | 'native'): Engine selection (default: 'auto')
  - password (string, optional): Password for an encrypted PDF. PDF/UA validation decrypts the document first so structure rules see real structures; permission-encrypted PDFs (empty user password) are decrypted automatically

Returns:
  Per-rule results with ISO clause references. compliant is true/false for veraPDF; for the native engine, false means definitive violations were found and null means "no violations in the checked subset" (NOT certification). PDF/UA native violations carry a severity: only 'error' rules can prove non-conformance, 'warning' rules need human review. For an encrypted PDF that cannot be decrypted, structure-dependent PDF/UA rules are reported in skippedRules (not checked) rather than as violations.

Note: PDF/UA cannot be fully decided by machine — whether alt text is *present* is checkable, whether it is *meaningful* is not. Use pdf-reader-mcp's inspect_tags to examine the structure tree itself.

Examples:
  - Check whether a scanned archive PDF actually meets its declared PDF/A-2b
  - Verify a generated document is tagged and accessible before publishing (pdfua-1)
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
        const parsed = await parsePdf(params.file_path, { password: params.password });
        const report = await validateConformance(parsed, params.file_path, {
          flavour: params.flavour,
          engine: params.engine,
          password: params.password,
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
