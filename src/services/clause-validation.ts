/**
 * validate_clauses — ISO 32000 本体条文の検査（T1）。
 *
 * **判定の中身はこのサーバに無い。** 条文 → 機械検査可能条件の写像と、その決定論的評価は
 * `@shuji-bonji/pdf-constraints` が持つ（PDFfamily specs/18）。ここがやるのは
 * ①パッケージを呼ぶ ②結果を family の語彙に翻訳する ③**どの版のテーブルで判定したかを明記する**、の 3 つ。
 *
 * **なぜ validate_conformance に混ぜないのか**: あちらは PDF/A（T2）で、判定主体は veraPDF である。
 * 「veraPDF はこう判定した」としか言えない領域と、条文を引用して断定できる T1 の領域を
 * 同じツールに入れると、レポートの読み手が判定主体を取り違える。
 *
 * **依存は完全固定**（`^` にしない）。npx のキャッシュは verify の版が変わるまで依存ごと凍結されるので、
 * 範囲指定は「テーブル更新が届かないのに環境ごとに版が割れる」最悪の組み合わせになる。
 * テーブルを増やしたら constraints を publish → ここの依存を上げて verify も publish する。
 */

import { checkFile, listTables } from '@shuji-bonji/pdf-constraints';

/** 収録済み制約 1 件の結果（pdf-constraints の 4 状態をそのまま運ぶ） */
export interface ClauseResult {
  constraintId: string;
  /** 評価対象（フォント名や "(document)"） */
  target: string;
  status: 'pass' | 'fail' | 'not_applicable' | 'needs_external_fact';
  /** needs_external_fact のとき、供給されていなかった外部事実 */
  missing?: string;
  failures?: {
    clauses: string[];
    message: string;
    fact: string;
    actual: unknown;
    /**
     * 条文の主語が PDF processor（書き込み行為）である場合 true。
     * ファイルから観測できるのは「誰かが破った痕跡」であって、直近の書き手の違反とは限らない。
     */
    traceOnly: boolean;
  }[];
}

export interface ClauseValidationReport {
  /** 判定の由来。同じ facts でも版が違えば規則が違いうるので必ず出す */
  constraintsVersion: string;
  tables: { name: string; version: string }[];
  subjects: number;
  results: ClauseResult[];
  /** fail した表明の総数（制約数ではない） */
  violations: number;
  /** 外部事実が無くて判定に到達しなかった制約の数 */
  notDecided: number;
  notes: string[];
}

export interface ClauseValidationOptions {
  domains?: string[];
  given?: Record<string, unknown>;
}

/** 同梱テーブル（ドメイン）の一覧 */
export function listClauseDomains(): string[] {
  return listTables();
}

export async function validateClauses(
  filePath: string,
  options: ClauseValidationOptions = {},
): Promise<ClauseValidationReport> {
  const report = await checkFile(filePath, {
    domains: options.domains,
    given: options.given,
  });

  const results: ClauseResult[] = report.results.map((r) => ({
    constraintId: r.constraint,
    target: r.target,
    status: r.status,
    missing: r.missing,
    failures: r.failures?.map((f) => ({
      clauses: f.clauses,
      message: f.message,
      fact: f.fact,
      actual: f.actual,
      traceOnly: f.traceOnly,
    })),
  }));

  const notDecided = results.filter((r) => r.status === 'needs_external_fact').length;

  const notes = [
    'Checked against the constraints bundled in @shuji-bonji/pdf-constraints — nothing else. ' +
      'The absence of failures is not proof of conformance.',
  ];
  if (notDecided > 0) {
    notes.push(
      `${notDecided} constraint(s) could not be decided because a fact outside the file was ` +
        'not supplied (see "given"). They are reported as needs_external_fact rather than ' +
        'being defaulted into a pass.',
    );
  }
  if (results.some((r) => r.failures?.some((f) => f.traceOnly))) {
    notes.push(
      'Some failures are marked as traces: the clause addresses the PDF processor (the act of ' +
        'writing), so the file shows that someone broke it — not that the last writer did.',
    );
  }

  return {
    constraintsVersion: report.packageVersion,
    tables: report.tables,
    subjects: report.subjects,
    results,
    violations: report.violations,
    notDecided,
    notes,
  };
}
