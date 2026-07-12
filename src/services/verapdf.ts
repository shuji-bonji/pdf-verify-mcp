/**
 * veraPDF CLI integration (v0.3).
 *
 * When veraPDF is installed (PDF_VERIFY_VERAPDF env var pointing at the
 * executable, or `verapdf` on PATH), PDF/A validation is delegated to it —
 * veraPDF is the authoritative implementation. Otherwise the native rule
 * subset (pdfa-validator.ts) is used.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VERAPDF_ENV, VERAPDF_TIMEOUT } from '../constants.js';
import { logger } from '../utils/logger.js';

const CONTEXT = 'verapdf';
const execFileAsync = promisify(execFile);

export interface VeraPdfViolation {
  ruleId: string;
  clause: string;
  description: string;
  failedChecks: number;
}

export interface VeraPdfReport {
  compliant: boolean;
  flavour: string;
  passedRules: number;
  failedRules: number;
  violations: VeraPdfViolation[];
}

let cachedPath: string | null | undefined;

/** Locate the veraPDF executable (env var first, then PATH) */
export async function findVeraPdf(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath;

  const envPath = process.env[VERAPDF_ENV];
  if (envPath) {
    cachedPath = envPath;
    return cachedPath;
  }
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(which, ['verapdf'], { timeout: 5000 });
    const found = stdout.split('\n')[0]?.trim();
    cachedPath = found || null;
  } catch {
    cachedPath = null;
  }
  return cachedPath;
}

/** Reset the cached executable path (for tests) */
export function resetVeraPdfCache(): void {
  cachedPath = undefined;
}

interface VeraPdfJsonRuleSummary {
  ruleStatus?: string;
  specification?: string;
  clause?: string;
  testNumber?: number;
  description?: string;
  failedChecks?: number;
}

interface VeraPdfJson {
  report?: {
    jobs?: {
      validationResult?: {
        compliant?: boolean;
        profileName?: string;
        details?: {
          passedRules?: number;
          failedRules?: number;
          ruleSummaries?: VeraPdfJsonRuleSummary[];
        };
      }[];
    }[];
  };
}

/**
 * Run veraPDF against a file.
 *
 * @param flavour veraPDF flavour id (e.g. '1b', '2b', '3b') or undefined for auto
 */
export async function runVeraPdf(
  executable: string,
  filePath: string,
  flavour?: string,
): Promise<VeraPdfReport> {
  const args = ['--format', 'json'];
  if (flavour) {
    args.push('--flavour', flavour);
  }
  args.push(filePath);

  let stdout: string;
  try {
    const result = await execFileAsync(executable, args, {
      timeout: VERAPDF_TIMEOUT,
      maxBuffer: 64 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    // veraPDF exits non-zero for non-compliant files but still writes the report
    const execError = error as { stdout?: string; message?: string };
    if (execError.stdout) {
      stdout = execError.stdout;
    } else {
      throw new Error(`veraPDF execution failed: ${execError.message ?? String(error)}`);
    }
  }

  let json: VeraPdfJson;
  try {
    json = JSON.parse(stdout) as VeraPdfJson;
  } catch {
    throw new Error(
      'veraPDF output is not valid JSON (check the veraPDF version supports --format json)',
    );
  }

  const validation = json.report?.jobs?.[0]?.validationResult?.[0];
  if (!validation) {
    throw new Error('veraPDF report contains no validation result');
  }

  const summaries = validation.details?.ruleSummaries ?? [];
  const violations: VeraPdfViolation[] = summaries
    .filter((s) => s.ruleStatus !== 'PASSED')
    .map((s) => ({
      ruleId: `${s.specification ?? ''} ${s.clause ?? ''}-${s.testNumber ?? ''}`.trim(),
      clause: s.clause ?? 'unknown',
      description: s.description ?? '',
      failedChecks: s.failedChecks ?? 0,
    }));

  logger.debug(
    CONTEXT,
    `veraPDF: compliant=${validation.compliant}, failedRules=${validation.details?.failedRules}`,
  );

  return {
    compliant: Boolean(validation.compliant),
    flavour: validation.profileName ?? flavour ?? 'auto',
    passedRules: validation.details?.passedRules ?? 0,
    failedRules: validation.details?.failedRules ?? violations.length,
    violations,
  };
}
