/**
 * Unified error handling for pdf-verify-mcp.
 *
 * エラー応答の形と語彙は PDF family の規約（pdf-agent-stack `docs/specs/06` §2.3）に従う
 * （SPEC-VERIFY-COMMON-ERRORS-001〜006）。
 */

import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { MAX_FILE_SIZE } from '../constants.js';

/**
 * このサーバが返す `code`。houki-hub family の共通語彙（上 6 つ）と、
 * 共通語彙に当たらない verify 固有のコード（下 5 つ）。
 */
export type VerifyErrorCode =
  | 'INVALID_ARGUMENT'
  | 'DOC_NOT_FOUND'
  | 'INVALID_PDF'
  | 'ENCRYPTED_PDF'
  | 'FILE_TOO_LARGE'
  | 'INTERNAL_ERROR'
  | 'INVALID_BYTE_RANGE'
  | 'WRONG_PASSWORD'
  | 'VERAPDF_NOT_FOUND'
  | 'VERAPDF_NOT_AVAILABLE'
  | 'VERAPDF_NO_RESULT';

/** `INVALID_ARGUMENT` の細かい理由。0.32.x まではこれが `code` だった。 */
export type InvalidArgumentReason =
  | 'MISSING_PATH'
  | 'RELATIVE_PATH'
  | 'NOT_A_FILE'
  | 'INVALID_FLAVOUR';

/**
 * 引数・フラグ・環境を変えれば同じ判定が成功しうるか（SPEC-VERIFY-COMMON-ERRORS-005）。
 * 値は code ごとに 1 つ。エラーを作る箇所では選ばせない —— 同じ code に 2 つの値があると、
 * 受け側は code で分岐できない。
 */
export const RETRYABLE: Readonly<Record<VerifyErrorCode, boolean>> = {
  INVALID_ARGUMENT: true,
  ENCRYPTED_PDF: true,
  WRONG_PASSWORD: true,
  VERAPDF_NOT_FOUND: true,
  VERAPDF_NOT_AVAILABLE: true,
  DOC_NOT_FOUND: false,
  INVALID_PDF: false,
  FILE_TOO_LARGE: false,
  INVALID_BYTE_RANGE: false,
  VERAPDF_NO_RESULT: false,
  INTERNAL_ERROR: false,
};

/**
 * 次に取る手の候補（pdf-agent-stack `docs/specs/06` §2.3。reader・writer と同じ形）。
 * 🔴 `action` と `example` のキーは受け側の Skill が分岐と再試行に使う。値を変えない。
 */
export interface NextAction {
  action: string;
  /** 英語の 1 文 */
  reason: string;
  example?: Record<string, unknown>;
}

/** pdf-verify-mcp specific error with a stable code and a recovery hint */
export class PdfVerifyError extends Error {
  constructor(
    message: string,
    public readonly code: VerifyErrorCode,
    public readonly hint?: string,
    public readonly reason?: InvalidArgumentReason,
    public readonly nextActions?: NextAction[],
  ) {
    super(message);
    this.name = 'PdfVerifyError';
  }

  get retryable(): boolean {
    return RETRYABLE[this.code];
  }
}

/** `INVALID_ARGUMENT` を作る。理由は `detail.reason` に出る。 */
export function invalidArgument(
  message: string,
  reason: InvalidArgumentReason,
  hint?: string,
): PdfVerifyError {
  return new PdfVerifyError(message, 'INVALID_ARGUMENT', hint, reason);
}

/**
 * ツール結果 `isError: true` の本文（pdf-agent-stack `docs/specs/06` §2.3）。
 *
 * 0.33.x は移行の版として `message`・`suggestion`・`detail.legacyCode` も返していた。
 * 0.34.0 で外した（SPEC-VERIFY-COMMON-ERRORS-001。006 は削除）。
 */
export interface StructuredError {
  /** 英語の 1 文 */
  error: string;
  code: VerifyErrorCode;
  retryable: boolean;
  hint?: string;
  /** 書くことがあるときだけ置く（SPEC-VERIFY-COMMON-ERRORS-001。0.35.0 は ENCRYPTED_PDF の 1 か所） */
  next_actions?: NextAction[];
  /** 書くことがあるときだけ置く（`INVALID_ARGUMENT` の細かい理由） */
  detail?: {
    reason?: InvalidArgumentReason;
  };
}

function toBody(
  error: string,
  code: VerifyErrorCode,
  options: { hint?: string; reason?: InvalidArgumentReason; nextActions?: NextAction[] } = {},
): StructuredError {
  return {
    error,
    code,
    retryable: RETRYABLE[code],
    ...(options.hint !== undefined ? { hint: options.hint } : {}),
    ...(options.nextActions && options.nextActions.length > 0
      ? { next_actions: options.nextActions }
      : {}),
    ...(options.reason !== undefined ? { detail: { reason: options.reason } } : {}),
  };
}

/** Convert any thrown value into a structured error payload */
export function handleStructuredError(error: unknown): StructuredError {
  if (error instanceof PdfVerifyError) {
    return toBody(error.message, error.code, {
      hint: error.hint,
      reason: error.reason,
      nextActions: error.nextActions,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return toBody(message, 'INTERNAL_ERROR');
}

/**
 * 構造が条文に反していて読めなかった、を返す（SPEC-VERIFY-COMMON-ERRORS-003）。
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
    'INVALID_PDF',
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

/**
 * Validate a local PDF file path and size before reading.
 *
 * 7 ツールとも、文書を開く前にここを通す（SPEC-VERIFY-COMMON-ERRORS-004）。
 */
export async function assertReadablePdf(filePath: string): Promise<void> {
  if (!filePath) {
    throw invalidArgument('File path is required', 'MISSING_PATH');
  }
  if (!isAbsolute(filePath)) {
    throw invalidArgument(
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
      'DOC_NOT_FOUND',
      'Check that the file exists and the path is correct',
    );
  }
  if (!info.isFile()) {
    throw invalidArgument(`Not a regular file: ${filePath}`, 'NOT_A_FILE');
  }
  if (info.size > MAX_FILE_SIZE) {
    throw new PdfVerifyError(
      `File too large: ${info.size} bytes (limit ${MAX_FILE_SIZE})`,
      'FILE_TOO_LARGE',
    );
  }
}
