/**
 * Unified error handling for pdf-verify-mcp.
 */

import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { MAX_FILE_SIZE } from '../constants.js';

/** pdf-verify-mcp specific error with a stable code and a recovery hint */
export class PdfVerifyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = 'PdfVerifyError';
  }
}

export interface StructuredError {
  error: true;
  code: string;
  message: string;
  suggestion?: string;
}

/** Convert any thrown value into a structured error payload */
export function handleStructuredError(error: unknown): StructuredError {
  if (error instanceof PdfVerifyError) {
    return {
      error: true,
      code: error.code,
      message: error.message,
      suggestion: error.suggestion,
    };
  }
  if (error instanceof Error) {
    return {
      error: true,
      code: 'INTERNAL_ERROR',
      message: error.message,
    };
  }
  return { error: true, code: 'INTERNAL_ERROR', message: String(error) };
}

/**
 * 構造が条文に反していて読めなかった、を返す。
 *
 * 🔴 **これは文書についての所見であって、サーバの故障ではない。**
 * `INTERNAL_ERROR` で返すと、受け側は「調べられませんでした」に落とす。
 * 7 ツールすべてがこの 1 つの作り方を通ること —— 同じ事実に 2 つの名前が
 * 付いていると、分岐する側は片方しか見ない。
 */
export function toStructuralRefusal(error: unknown): PdfVerifyError {
  if (error instanceof PdfVerifyError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new PdfVerifyError(
    `Failed to parse PDF: ${message}`,
    'PARSE_FAILED',
    STRUCTURAL_REFUSAL_HINT,
  );
}

/**
 * 受け側に「これは所見である」と伝える 1 文。`code` だけでは
 * 「読めなかった」が「壊れていた」なのか「サーバが落ちた」なのか分かれない。
 */
export const STRUCTURAL_REFUSAL_HINT =
  'The document does not satisfy the structural clause named in the message, so it could not be ' +
  'read as written. This is a finding about the file, not a failure of this server — record it ' +
  'as a structural violation, not as a check that could not be performed.';

/** Validate a local PDF file path and size before reading */
export async function assertReadablePdf(filePath: string): Promise<void> {
  if (!filePath) {
    throw new PdfVerifyError('File path is required', 'MISSING_PATH');
  }
  if (!isAbsolute(filePath)) {
    throw new PdfVerifyError(
      `Path must be absolute: ${filePath}`,
      'RELATIVE_PATH',
      'Provide an absolute path such as /path/to/document.pdf',
    );
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(filePath);
  } catch {
    throw new PdfVerifyError(
      `File not found: ${filePath}`,
      'FILE_NOT_FOUND',
      'Check that the file exists and the path is correct',
    );
  }
  if (!info.isFile()) {
    throw new PdfVerifyError(`Not a regular file: ${filePath}`, 'NOT_A_FILE');
  }
  if (info.size > MAX_FILE_SIZE) {
    throw new PdfVerifyError(
      `File too large: ${info.size} bytes (limit ${MAX_FILE_SIZE})`,
      'FILE_TOO_LARGE',
    );
  }
}
