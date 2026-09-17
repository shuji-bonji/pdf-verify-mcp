/**
 * Common Zod schemas shared across tools.
 */

import { z } from 'zod';
import { DEFAULT_REVOCATION_FRESHNESS_SECONDS, ResponseFormat } from '../constants.js';

/** File path parameter for local PDF files */
export const FilePathSchema = z
  .string()
  .min(1, 'File path is required')
  .describe('Absolute path to a local PDF file (e.g., "/path/to/document.pdf")');

/** Response format parameter */
export const ResponseFormatSchema = z
  .enum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe('Output format: "markdown" for human-readable, "json" for structured data');

/** 共通入力の raw shape。ツール固有の引数を足すときに展開して使う。 */
export const PdfToolInputShape = {
  file_path: FilePathSchema,
  response_format: ResponseFormatSchema,
};

/**
 * 失効確認の細かな指定（v0.28.0, #16）。verify_signatures と evaluate_policy が共有する。
 */
export const RevocationOptionShape = {
  revocation_freshness: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_REVOCATION_FRESHNESS_SECONDS)
    .describe(
      'Seconds before the validation time that a CRL / OCSP response may have been issued (thisUpdate) and still support "good". Default 86400 (24 h); 0 accepts only data issued at or after the validation time. Older data gives "unknown".',
    ),
  trusted_ocsp_responders: z
    .array(z.string())
    .optional()
    .describe(
      'Absolute paths to certificates (PEM or DER) of locally trusted OCSP responders (RFC 6960 §4.2.2.2). A response signed by one of them is accepted even when the responder is not the issuing CA or its delegate.',
    ),
};

/**
 * 共通入力だけを取るツールに渡す ZodObject。
 *
 * `.strict()` を明示している理由: zod 3 の JSON Schema 変換は素の ZodObject にも
 * `additionalProperties: false` を付けていたため、書かなくても `tools/list` の
 * `inputSchema` には `false` が入っていた。zod 4 は付けない。書かないまま zod を
 * 上げると、`tools/list` から `additionalProperties: false` が消え、クライアントは
 * 「宣言に無いキーも渡してよい」と読む（2026-08-27 に 7 ツールすべてで実測）。
 * `additionalProperties: false` を返すのは family 規約の既定である。
 */
export const PdfToolInputSchema = z.object(PdfToolInputShape).strict();

export type PdfToolInput = {
  file_path: string;
  response_format: ResponseFormat;
};
