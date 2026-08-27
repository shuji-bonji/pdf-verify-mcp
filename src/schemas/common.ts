/**
 * Common Zod schemas shared across tools.
 */

import { z } from 'zod';
import { ResponseFormat } from '../constants.js';

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
