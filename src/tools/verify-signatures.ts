/**
 * verify_signatures - Cryptographic verification of PDF digital signatures.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ResponseFormat, RevocationMode } from '../constants.js';
import { PdfToolInputSchema } from '../schemas/common.js';
import { parsePdf } from '../services/pdf-parser.js';
import { verifySignatures } from '../services/verification-service.js';
import { handleStructuredError } from '../utils/error-handler.js';
import { formatSignatureReports, truncateIfNeeded } from '../utils/formatter.js';

const VerifySignaturesSchema = {
  ...PdfToolInputSchema,
  trust_anchors: z
    .array(z.string())
    .optional()
    .describe(
      'Absolute paths to trust anchor certificates (PEM or DER). Merged with the PDF_VERIFY_TRUST_ANCHORS environment variable (a directory of *.pem/*.crt/*.cer/*.der files). When omitted and the env var is unset, trust is reported as not_evaluated.',
    ),
  check_revocation: z
    .nativeEnum(RevocationMode)
    .default(RevocationMode.EMBEDDED)
    .describe(
      'Revocation checking: "none", "embedded" (OCSP/CRL data inside the PDF/CMS, default), or "online" (additionally query OCSP responders and CRL distribution points over HTTP).',
    ),
  password: z
    .string()
    .optional()
    .describe(
      'Password for an encrypted PDF. Omit for permission-encrypted PDFs (an empty user password is tried automatically).',
    ),
};

type VerifySignaturesInput = {
  file_path: string;
  response_format: ResponseFormat;
  trust_anchors?: string[];
  check_revocation: RevocationMode;
  password?: string;
};

export function registerVerifySignatures(server: McpServer): void {
  server.registerTool(
    'verify_signatures',
    {
      title: 'Verify PDF Digital Signatures (cryptographic)',
      description: `Cryptographically verify the digital signatures in a PDF document.

For each signature this tool: recomputes the ByteRange digest and compares it with the CMS messageDigest attribute, verifies the CMS/PKCS#7 signature value against the signer certificate, verifies any RFC 3161 signature timestamp, evaluates the certificate chain against trust anchors, and checks revocation status.

Args:
  - file_path (string): Absolute path to a local PDF file
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')
  - trust_anchors (string[], optional): Paths to trust anchor certificates (PEM/DER). Also reads the PDF_VERIFY_TRUST_ANCHORS env var (directory).
  - check_revocation ('none' | 'embedded' | 'online'): Revocation mode (default: 'embedded'; 'online' queries OCSP/CRL endpoints over HTTP)

Returns:
  Per-signature verdict ('valid' / 'invalid' / 'indeterminate'), trust status ('trusted' / 'untrusted' / 'not_evaluated' with certificate path), revocation status ('good' / 'revoked' / 'unknown' / 'not_checked'), and signature timestamp verification.

Note: without trust_anchors (or the env var), trust is reported as not_evaluated — a 'valid' verdict then means cryptographic integrity, not signer identity assurance.

Complements pdf-reader-mcp's inspect_signatures, which inspects structure only.

Examples:
  - Verify a signed contract has not been altered since signing
  - Validate a signature against your organization's CA (trust_anchors)
  - Check whether the signer certificate has been revoked (check_revocation: "online")`,
      inputSchema: VerifySignaturesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // check_revocation='online' may reach OCSP/CRL endpoints
        openWorldHint: true,
      },
    },
    async (params: VerifySignaturesInput) => {
      try {
        const parsed = await parsePdf(params.file_path, { password: params.password });
        const reports = await verifySignatures(parsed, {
          trustAnchorPaths: params.trust_anchors,
          revocationMode: params.check_revocation,
        });
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
