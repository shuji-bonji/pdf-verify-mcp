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
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe('Output format: "markdown" for human-readable, "json" for structured data');

export const PdfToolInputSchema = {
  file_path: FilePathSchema,
  response_format: ResponseFormatSchema,
};

export type PdfToolInput = {
  file_path: string;
  response_format: ResponseFormat;
};
