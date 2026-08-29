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

import { readFile } from 'node:fs/promises';
import { checkFile, listTables } from '@shuji-bonji/pdf-constraints';
import type { ReadingScope } from '../types.js';
import { openDocument, toReadingScope } from './document.js';

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
    /**
     * 制約が持つ文脈（pdf-constraints 0.3.0+）。**判定は変えない**が、
     * これが無いと技術的に正しいまま誤読される種類の fail に付く。
     * 例: CT-ANNOT-9（QuadPoints の反時計回り）は業界がほぼ一様に逸脱している。
     */
    note?: string;
  }[];
}

/**
 * どこまで読めたか（pdf-constraints 0.4.0+ の `CheckReport.observation`）。
 * **判定ではなく判定の射程。** 「制約に違反していない」と「その対象を観測できていない」は
 * 別のことで、これが無いと後者が前者の顔をする（L1 の A/B で実際にそうなった:
 * `/Prev 0` でチェーンが 2 段で止まった文書の subject が 10 -> 1 に減ったのに、
 * results は「違反なし」のままだった）。
 */
export interface ClauseObservation {
  /** リビジョンチェーンの歩きがどこで止まったか（§7.5.6）。`complete` 以外は文書全体を見ていない */
  xrefChain: string;
  /** 相互参照表に載っている（= 読めるはずの）オブジェクトの数 */
  objects: number;
  /** ページツリーに到達できたか。false のとき、注釈の subject が 0 でも「注釈が無い」ではない */
  pagesReached: boolean;
  /** 到達できたページ数 */
  pages: number;
}

export interface ClauseValidationReport {
  /**
   * どこまで読んだか。**判定ではない。**
   *
   * `observation` と重なって見えるが別の測り方である。`scope` は
   * **この文書をどう開いたか**（回復に入ったか・表を組み直したか）、
   * `observation` は **pdf-constraints が何を見たか**（対象とページ）。
   */
  scope: ReadingScope;
  /** 判定の由来。同じ facts でも版が違えば規則が違いうるので必ず出す */
  constraintsVersion: string;
  tables: { name: string; version: string }[];
  /** 判定の射程。**数字より先に読ませる**（formatter は見出し直下に置く） */
  observation: ClauseObservation;
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
  // 判定より先に「どう開いたか」を採る。checkFile は自分でファイルを読むので、
  // ここで開くのは射程を申告するためだけ（2,950 検体で 1 文書 0.3 ミリ秒）。
  const scope = toReadingScope(
    (await openDocument(new Uint8Array(await readFile(filePath)))).scope,
  );

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
      note: f.note,
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
  if (report.observation.xrefChain !== 'complete') {
    notes.push(
      `The revision chain could not be walked to the end (${report.observation.xrefChain}), so ` +
        'the constraints were applied to PART of the document. Absence of a failure here does ' +
        'not mean the constraint holds for the whole file.',
    );
  }
  if (!report.observation.pagesReached) {
    notes.push(
      'The page tree could not be reached, so no page-scoped subject (annotations, page ' +
        'resources) was examined at all — a count of zero means "not looked at", not "none".',
    );
  }
  if (results.some((r) => r.failures?.some((f) => f.traceOnly))) {
    notes.push(
      'Some failures are marked as traces: the clause addresses the PDF processor (the act of ' +
        'writing), so the file shows that someone broke it — not that the last writer did.',
    );
  }

  return {
    scope,
    constraintsVersion: report.packageVersion,
    tables: report.tables,
    observation: report.observation,
    subjects: report.subjects,
    results,
    violations: report.violations,
    notDecided,
    notes,
  };
}
