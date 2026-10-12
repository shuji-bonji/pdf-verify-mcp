/**
 * identify_conformance - PDF/A / PDF/UA declaration identification.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { ResponseFormat } from '../constants.js';
import { type PdfToolInput, PdfToolInputSchema } from '../schemas/common.js';
import { identifyConformance } from '../services/conformance.js';
import { parsePdf } from '../services/pdf-parser.js';
import { handleStructuredError } from '../utils/error-handler.js';
import { formatConformanceReport, renderBody } from '../utils/formatter.js';

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
  Every report begins with a "scope" object - how far the reading got, not a verdict: whether the cross-reference chain could be walked to the end (chainStop), whether this tool had to rebuild the cross-reference table itself (reconstructed - when true, the table is this tool's reconstruction and not the one the file carries), how many objects and sections were read, and whether an encrypted document could be opened. Read it before the verdict: "no violations" over a rebuilt table is not the same statement as "no violations" over the file's own table.

  Declared PDF/A part/conformance level and PDF/UA part, plus the PDF version.

  xmpNamespaces (v0.31.0): every namespace the packet declares, each marked predefined (XMP Specification / ISO 19005), describedByExtensionSchema (a pdfaSchema:namespaceURI in the packet names it), and known (what this family can say it is — e.g. the W3C TDMRep namespace, or pdfuaid). A PDF/A declaration together with a namespace that is neither predefined nor described is what a PDF/A validator reports under ISO 19005-2 6.6.2.3 (19005-1 6.7.8); the note says so, as a declaration-level observation, not a validation result.

IMPORTANT: This tool only IDENTIFIES the declared conformance — a declaration does not guarantee actual conformance. For real PDF/A rule checking use the validate_conformance tool (native rule subset, or veraPDF when installed).

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
        const text = renderBody(params.response_format === ResponseFormat.JSON, report, () =>
          formatConformanceReport(report),
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
