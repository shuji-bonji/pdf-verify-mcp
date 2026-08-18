/**
 * veraPDF CLI integration (v0.3).
 *
 * When veraPDF is installed (PDF_VERIFY_VERAPDF env var pointing at the
 * executable, or `verapdf` on PATH), PDF/A validation is delegated to it —
 * veraPDF is the authoritative implementation. Otherwise the native rule
 * subset (pdfa-validator.ts) is used.
 */

import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs';
import { promisify } from 'node:util';
import { VERAPDF_ENV, VERAPDF_TIMEOUT } from '../constants.js';
import { logger } from '../utils/logger.js';

const CONTEXT = 'verapdf';
const execFileAsync = promisify(execFile);
const accessAsync = promisify(access);

/**
 * Well-known install locations, checked after PATH. GUI-launched MCP hosts
 * (e.g. Claude Desktop on macOS) often have a minimal PATH that excludes
 * Homebrew's bin directories.
 */
const WELL_KNOWN_PATHS = [
  '/opt/homebrew/bin/verapdf', // Homebrew (Apple Silicon)
  '/usr/local/bin/verapdf', // Homebrew (Intel) / manual install
  '/usr/bin/verapdf',
];

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

/**
 * Where the executable came from. Recorded because "which veraPDF ran" is part
 * of the provenance of a verdict: the same env var pointing at a different
 * build produces a different rule count.
 */
export type VeraPdfSource = 'env' | 'path' | 'well-known';

/**
 * The result of looking for veraPDF.
 *
 * `configured_path_unusable` is kept distinct from `not_installed` on purpose.
 * A stale `PDF_VERIFY_VERAPDF` is a *misconfiguration* — the operator asked for
 * a specific validator and it is not there — whereas `not_installed` is simply
 * an environment without veraPDF. Collapsing the two hides the mistake, and
 * silently falling through to another binary would be worse still: the verdict
 * would then come from a validator nobody chose.
 */
export type VeraPdfAvailability =
  | { available: true; path: string; source: VeraPdfSource }
  | { available: false; reason: 'not_installed' }
  | {
      available: false;
      reason: 'configured_path_unusable';
      configuredPath: string;
      detail: string;
    };

let cachedAvailability: VeraPdfAvailability | undefined;

/**
 * Locate the veraPDF executable (env var first, then PATH, then well-known
 * locations) and report *why* when it cannot be used.
 *
 * The env var is checked for executability like every other candidate. It used
 * to be trusted blindly, so a stale path was accepted as found and only failed
 * later inside execFile — surfacing as "veraPDF execution failed" instead of
 * "the validator you configured is not there". That is the failure mode this
 * function exists to prevent.
 */
export async function resolveVeraPdf(): Promise<VeraPdfAvailability> {
  if (cachedAvailability !== undefined) return cachedAvailability;

  const envPath = process.env[VERAPDF_ENV];
  if (envPath) {
    try {
      await accessAsync(envPath, constants.X_OK);
      cachedAvailability = { available: true, path: envPath, source: 'env' };
    } catch (error) {
      // Deliberately NOT falling through to PATH: an explicit setting that is
      // wrong must surface, not be papered over by a different executable.
      cachedAvailability = {
        available: false,
        reason: 'configured_path_unusable',
        configuredPath: envPath,
        detail:
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : 'not executable',
      };
      logger.debug(CONTEXT, `${VERAPDF_ENV}=${envPath} is not executable`);
    }
    return cachedAvailability;
  }

  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(which, ['verapdf'], { timeout: 5000 });
    const found = stdout.split('\n')[0]?.trim();
    if (found) {
      cachedAvailability = { available: true, path: found, source: 'path' };
      return cachedAvailability;
    }
  } catch {
    // fall through to well-known locations
  }

  for (const candidate of WELL_KNOWN_PATHS) {
    try {
      await accessAsync(candidate, constants.X_OK);
      logger.debug(CONTEXT, `veraPDF found at well-known path: ${candidate}`);
      cachedAvailability = { available: true, path: candidate, source: 'well-known' };
      return cachedAvailability;
    } catch {
      // try next
    }
  }
  cachedAvailability = { available: false, reason: 'not_installed' };
  return cachedAvailability;
}

/** Locate the veraPDF executable, or null when it cannot be used. */
export async function findVeraPdf(): Promise<string | null> {
  const availability = await resolveVeraPdf();
  return availability.available ? availability.path : null;
}

/**
 * Pull the version out of `verapdf --version` output.
 *
 * 🔴 **Not the first line.** The JVM writes warnings before it (measured with
 * veraPDF 1.30.0 on Homebrew, 2026-08-18):
 *
 * ```
 * WARNING: Final field flavour in class org.verapdf... has been mutated reflectively
 * WARNING: Use --enable-final-field-mutation=ALL-UNNAMED to avoid a warning
 * WARNING: Mutating final fields will be blocked in a future release...
 * veraPDF 1.30.0
 * Built: Wed Jun 03 13:47:00 JST 2026
 * ```
 *
 * Returns null when no such line is there — an unrecognised build is recorded
 * as "unknown", never guessed.
 */
export function parseVeraPdfVersion(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*veraPDF\s+(\S+)\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

const cachedVersions = new Map<string, string | null>();

/**
 * The version of a resolved veraPDF executable, or null when it cannot be read.
 *
 * **Why this is asked for at all.** The file header says which veraPDF ran is
 * part of the provenance of a verdict, and the path alone does not answer it:
 * on the machine this was measured, Homebrew's directory says `1.30.2` while
 * veraPDF answers `1.30.0`. A rule count is only comparable across runs of the
 * *same* build, so the number that decided a verdict has to travel with it.
 *
 * Cached per executable: one extra process per server lifetime, not per file.
 */
export async function veraPdfVersion(executable: string): Promise<string | null> {
  const cached = cachedVersions.get(executable);
  if (cached !== undefined) return cached;

  let version: string | null = null;
  try {
    const { stdout, stderr } = await execFileAsync(executable, ['--version'], { timeout: 15000 });
    // The warnings may land on either stream depending on the JVM; read both.
    version = parseVeraPdfVersion(stdout) ?? parseVeraPdfVersion(stderr);
  } catch (error) {
    // A validator that cannot say its version still validates. Record "unknown"
    // rather than refusing the verdict.
    logger.debug(CONTEXT, `could not read the veraPDF version: ${String(error)}`);
  }
  cachedVersions.set(executable, version);
  return version;
}

/** Reset the cached lookup (for tests) */
export function resetVeraPdfCache(): void {
  cachedAvailability = undefined;
  cachedVersions.clear();
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
