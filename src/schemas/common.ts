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
 * `additionalProperties: false` を付けていたため、書かなくても広告は `false` だった。
 * zod 4 は付けない。書かないまま zod を上げると、宣言していない引数を受け付ける
 * 広告に黙って変わる（2026-08-27 に 7 ツールすべてで実測）。
 * 広告を `false` に保つのは family 規約の既定である。
 */
export const PdfToolInputSchema = z.object(PdfToolInputShape).strict();

export type PdfToolInput = {
  file_path: string;
  response_format: ResponseFormat;
};
