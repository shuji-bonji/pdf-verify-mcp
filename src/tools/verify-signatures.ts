/**
 * verify_signatures - Cryptographic verification of PDF digital signatures.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResponseFormat } from '../constants.js';
import { type PdfToolInput, PdfToolInputSchema } from '../schemas/common.js';
import { parsePdf } from '../services/pdf-parser.js';
import { verifySignatures } from '../services/verification-service.js';
import { handleStructuredError } from '../utils/error-handler.js';
import { formatSignatureReports, truncateIfNeeded } from '../utils/formatter.js';

export function registerVerifySignatures(server: McpServer): void {
  server.registerTool(
    'verify_signatures',
    {
      title: 'Verify PDF Digital Signatures (cryptographic)',
      description: `Cryptographically verify the digital signatures in a PDF document.

For each signature this tool: recomputes the ByteRange digest and compares it with the CMS messageDigest attribute, verifies the CMS/PKCS#7 signature value against the signer certificate, and summarizes the embedded certificates (subject, issuer, validity).

Args:
  - file_path (string): Absolute path to a local PDF file
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  Per-signature verdict: 'valid' (cryptographically valid), 'invalid' (digest mismatch or signature failure — possible tampering), or 'indeterminate' (unsupported format or verification could not complete).

IMPORTANT: Certificate trust chains are NOT evaluated against trust anchors in v0.1 — every result carries trust: 'not_evaluated'. A 'valid' verdict means cryptographic integrity, not signer identity assurance.

Complements pdf-reader-mcp's inspect_signatures, which inspects structure only.

Examples:
  - Verify a signed contract has not been altered since signing
  - Check which signature in a multi-signature document is broken`,
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
        const reports = await verifySignatures(parsed);
        const raw =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(reports, null, 2)
            : formatSignatureReports(reports);
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
