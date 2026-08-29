/**
 * verify_signatures - Cryptographic verification of PDF digital signatures.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { toReadingScope } from '@normativepdf/recover';
import { z } from 'zod';
import { ResponseFormat, RevocationMode } from '../constants.js';
import { PdfToolInputShape } from '../schemas/common.js';
import { parsePdf } from '../services/pdf-parser.js';
import { verifySignatures } from '../services/verification-service.js';
import type { SignatureVerificationResult } from '../types.js';
import { handleStructuredError } from '../utils/error-handler.js';
import { formatSignatureReports, truncateIfNeeded } from '../utils/formatter.js';

const VerifySignaturesSchema = z
  .object({
    ...PdfToolInputShape,
    trust_anchors: z
      .array(z.string())
      .optional()
      .describe(
        'Absolute paths to trust anchor certificates (PEM or DER). Merged with the PDF_VERIFY_TRUST_ANCHORS environment variable (a directory of *.pem/*.crt/*.cer/*.der files). When omitted and the env var is unset, trust is reported as not_evaluated.',
      ),
    check_revocation: z
      .enum(RevocationMode)
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
  })
  .strict();

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
  - password (string, optional): Password for an encrypted PDF (permission-encrypted PDFs are decrypted automatically with the empty user password)

Returns:
  An object of the form { scope, signatures: [...] }. The top level changed from an array to an object in v0.21.0 - read .signatures for the list.

  Every report begins with a "scope" object - how far the reading got, not a verdict: whether the cross-reference chain could be walked to the end (chainStop), whether this tool had to rebuild the cross-reference table itself (reconstructed - when true, the table is this tool's reconstruction and not the one the file carries), how many objects and sections were read, and whether an encrypted document could be opened. Read it before the verdict: "no violations" over a rebuilt table is not the same statement as "no violations" over the file's own table. For this tool it matters most: when scope.reconstructed is true, a signature the rebuild did not reach is absent from the list, so a short or empty list is not proof that the file carries no other signatures.

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
        // 🔴 0.21.0 で最上位を配列から辞書にした。署名の一覧と、その一覧が
        // どこまでを見たものかを、同じ場所で読めるようにするため。
        const result: SignatureVerificationResult = {
          scope: toReadingScope(parsed.scope),
          signatures: await verifySignatures(parsed, {
            trustAnchorPaths: params.trust_anchors,
            revocationMode: params.check_revocation,
          }),
        };
        const raw =
          params.response_format === ResponseFormat.JSON
            ? JSON.stringify(result, null, 2)
            : formatSignatureReports(result);
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
