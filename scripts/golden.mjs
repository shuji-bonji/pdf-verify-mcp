#!/usr/bin/env node
/**
 * 7 ツールの出力のゴールデンを採り、2 つを突き合わせる（B2 = pdf-verify-mcp の pdf-lib 撤去の L0）。
 *
 * **なぜ撤去前にしか採れないか**: 撤去後に採り直すと、同じパーサ同士の比較になる。
 * pdf-lib で採ったこのゴールデン自体が「第 2 の独立した読み手」を兼ねる
 * （docs/handoff/pdflib-removal.md §6 面 3）。**撤去後に作り直さないこと。**
 *
 * **どこで測るか**: 登録済みツールを InMemoryTransport 越しに呼ぶ。サービス層を直接呼ぶと
 * `handleStructuredError` と `isError` の経路が写らない。クライアントが受け取る応答が契約である
 * （tests/unit/registry.test.ts と同じ立場）。
 *
 * 何を凍結するか — ツール出力の中身をそのまま持つ。要約しない:
 *   ファイル × ツールごとに `raw`（JSON をそのまま）と `kept`（判定に効く項目を平らにしたもの）、
 *   それに `raw` 全体の sha。kept に無い変化も sha で出る。
 *   読めなかったファイルは落とさず `isError: true` として記録する（暗号化検体がここに出る）。
 *
 * 版（constraintsVersion / tables）は行ではなくヘッダで比べる。0.3.0 -> 0.4.0 で
 * 全ファイルが差になると、判定の差が埋もれるため。
 *
 * 使い方:
 *   node scripts/golden.mjs take <out.json> [--set <dir>]... [--label NAME] [--limit N] [--resume]
 *   node scripts/golden.mjs diff <before.json> <after.json> [--detail <file-key>] [--max N]
 *   node scripts/golden.mjs report <golden.json>    # 採ったものの軸の申告を読み直す
 *   node scripts/golden.mjs t3   [golden.json]      # 計器自身の T-3。採る前に通す
 *
 * 🔴 `--set` は 1 つずつ直接書く（B1 で `$SETS` が 1 引数として届き、既定の集合で
 *    「採れた」顔のゴールデンが出た）。
 *
 * 終了コード: 0 = 差なし / 1 = 差あり / 2 = 使い方の誤り・自己検査に失敗
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** 既定の検体集合。B1 の 9.4「fixtures と veraPDF コーパスだけでは足りない」を受けたもの。 */
const DEFAULT_SETS = [
  join(ROOT, '.golden/specimens'),
  join(ROOT, 'tests/fixtures/generated'),
  resolve(ROOT, '../../lib/normativepdf/corpus/veraPDF-corpus'),
  resolve(ROOT, '../../lib/normativepdf/corpus/pdf20examples'),
  resolve(ROOT, '../../lib/normativepdf/corpus/_wout'),
];

const TOOLS = [
  'verify_signatures',
  'verify_integrity',
  'detect_pades_level',
  'identify_conformance',
  'validate_conformance',
  'validate_clauses',
  'evaluate_policy',
];

/** 🔴 engine は native に固定する。pdf-lib が居るのは native の 2 本だけで、 */
/** veraPDF を挟むと撤去と無関係な差（veraPDF の有無）が全件に乗る。 */
const FIXED_ARGS = { validate_conformance: { engine: 'native' } };

/** 時刻に依存して動く項目。差が出たらまずここを疑う（帰属の手がかりとしてヘッダに残す）。 */
const TIME_DEPENDENT = [
  'verify_signatures[].cms.signerCertificate.isExpiredNow',
  'evaluate_policy.facts.signatures[].certificateExpired',
];

/** 版はヘッダで比べる。ここに挙げた道は per-file の比較から外す。 */
const HOISTED = [
  ['validate_clauses', 'constraintsVersion'],
  ['validate_clauses', 'tables'],
];

const sha = (s) => createHash('sha256').update(s ?? '').digest('hex').slice(0, 16);

/**
 * ツール出力が JSON として読めなかった entry。`truncateIfNeeded` が長い出力を切るので、
 * **大きい文書でだけ起きる**。このとき kept は空で、判定も対象数も 1 つも取れていない。
 * 🔴 「差が無い」と数えてはいけない —— 何も測っていない。
 * 古いゴールデン（この印を持たない）でも判るよう、raw の形から見分ける。
 */
const isUnparsed = (entry) =>
  entry?.parsed === false ||
  (entry?.raw && typeof entry.raw === 'object' && !Array.isArray(entry.raw) &&
    Object.keys(entry.raw).length === 1 && '_text' in entry.raw);

/** キー順に依存しない JSON 文字列（比較の同一性をキー順で崩さない）。 */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

function listPdfs(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (e.name.startsWith('_stale')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** 集合の名前。パスそのものは環境なので、キーには短い名前だけを使う。 */
function setToken(dir) {
  const b = basename(dir);
  return b === 'generated' ? 'fixtures' : b === 'veraPDF-corpus' ? 'veraPDF' : b;
}

/** raw の中に出る絶対パスを、環境ではなく集合の名前に置き換える。 */
function maskPaths(value, masks) {
  if (typeof value === 'string') {
    let s = value;
    for (const [from, to] of masks) s = s.split(from).join(to);
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => maskPaths(v, masks));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = maskPaths(value[k], masks);
    return out;
  }
  return value;
}

// --------------------------------------------------------------------------
// kept — 判定に効く項目を平らにする。差の分類（後退か是正か）はここを見て決める。
// --------------------------------------------------------------------------

const N = (v) => (Array.isArray(v) ? v.length : v == null ? null : v);

function keptOf(tool, raw) {
  if (raw == null) return null;
  switch (tool) {
    case 'verify_signatures':
      return {
        count: Array.isArray(raw) ? raw.length : null,
        sigs: (Array.isArray(raw) ? raw : []).map((s) => ({
          field: s.fieldName ?? null,
          verdict: s.verdict ?? null,
          trust: s.trust?.status ?? null,
          revocation: s.revocation?.status ?? null,
          covers: s.coversEntireFile ?? null,
          cmsVerified: s.cms?.signatureVerified ?? null,
          digestMatches: s.cms?.digestMatches ?? null,
          cmsError: s.cms?.error != null,
        })),
      };
    case 'verify_integrity':
      return {
        revisionCount: raw.revisionCount ?? null,
        incrementalUpdateCount: raw.incrementalUpdateCount ?? null,
        signatureCount: raw.signatureCount ?? null,
        lastSignatureCoversFile: raw.lastSignatureCoversFile ?? null,
        hasDss: raw.hasDss ?? null,
        certified: raw.certification != null,
        chain: raw.revisionChain?.status ?? null,
        chainMissing: N(raw.revisionChain?.missing),
        agreement: raw.revisionCountAgreement?.status ?? null,
        revisions: N(raw.revisions),
        laterChanges: N(raw.signaturesWithLaterChanges),
      };
    case 'detect_pades_level':
      return {
        count: Array.isArray(raw) ? raw.length : null,
        levels: (Array.isArray(raw) ? raw : []).map((r) => ({
          field: r.fieldName ?? null,
          isPades: r.isPades ?? null,
          level: r.level ?? null,
          basis: r.normativeBasis ?? null,
          ts: r.evidence?.hasSignatureTimestamp ?? null,
          dss: r.evidence?.hasDss ?? null,
          vri: r.evidence?.hasVri ?? null,
          dts: r.evidence?.hasDocumentTimestamp ?? null,
        })),
      };
    case 'identify_conformance':
      return {
        hasXmp: raw.hasXmp ?? null,
        pdfA: raw.pdfA ? `${raw.pdfA.part}${raw.pdfA.conformance ?? ''}` : null,
        pdfUa: raw.pdfUa ? String(raw.pdfUa.part) : null,
        pdfVersion: raw.pdfVersion ?? null,
      };
    case 'validate_conformance':
      return {
        flavour: raw.flavour ?? null,
        compliant: raw.compliant ?? null,
        checkedRules: raw.checkedRules ?? null,
        passedRules: raw.passedRules ?? null,
        failedRules: raw.failedRules ?? null,
        violations: (raw.violations ?? []).map((v) => v.ruleId).sort(),
        skipped: (raw.skippedRules ?? []).map((v) => v.ruleId ?? v).sort(),
        authPerformed: raw.authoritativeValidation?.performed ?? null,
        authReason: raw.authoritativeValidation?.reason ?? null,
      };
    case 'validate_clauses': {
      const results = raw.results ?? [];
      const byStatus = {};
      for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      return {
        subjects: raw.subjects ?? null,
        results: results.length,
        byStatus,
        rows: results.map((r) => [r.constraintId, r.target, r.status]),
        observation: raw.observation ?? null,
      };
    }
    case 'evaluate_policy':
      return {
        profile: raw.profile ?? null,
        verdict: raw.verdict ?? null,
        fired: (raw.firedRules ?? []).map((r) => r.ruleId).sort(),
        advisories: (raw.advisories ?? []).map((r) => r.ruleId ?? r).sort(),
        signatureCount: raw.facts?.signatureCount ?? null,
        revisionCount: raw.facts?.revisionCount ?? null,
      };
    default:
      return null;
  }
}

/** エラー応答は、届け先（isError）と、条文を名指ししているかを残す。 */
function keptOfError(raw, text) {
  const msg = typeof raw?.message === 'string' ? raw.message : text;
  return {
    code: raw?.code ?? raw?.error?.code ?? null,
    name: raw?.name ?? raw?.error?.name ?? null,
    messageSha: sha(msg),
    /** 条文を名指ししているか（受入の条件。§6 面 2 の表）。 */
    namesClause: /\b(7\.\d+(\.\d+)*|ISO\s*32000|ISO\s*14289|ISO\s*19005|R-\d)/.test(msg ?? ''),
    messageHead: (msg ?? '').slice(0, 160),
  };
}

// --------------------------------------------------------------------------
// take
// --------------------------------------------------------------------------

function depVersions() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const out = { self: pkg.version };
  for (const name of ['pdf-lib', 'normativepdf', '@shuji-bonji/pdf-constraints']) {
    const p = join(ROOT, 'node_modules', name, 'package.json');
    out[name] = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).version : null;
  }
  return out;
}

async function take(outPath, opts) {
  const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
  const { buildServer } = await import('../dist/server.js');

  const sets = (opts.sets.length ? opts.sets : DEFAULT_SETS).map((d) => resolve(d));
  for (const d of sets) {
    if (!existsSync(d)) {
      console.error(`検体集合が無い: ${d}`);
      process.exit(2);
    }
  }

  const masks = sets.map((d) => [`${d}/`, `{${setToken(d)}}/`]);
  const targets = [];
  for (const d of sets) {
    const token = setToken(d);
    const manifestPath = join(d, 'manifest.json');
    const manifest = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, 'utf8'))
      : null;
    const byName = new Map((manifest?.specimens ?? []).map((s) => [s.name, s]));
    for (const p of listPdfs(d)) {
      const rel = relative(d, p);
      const m = byName.get(rel);
      targets.push({
        key: `{${token}}/${rel}`,
        path: p,
        set: token,
        axes: m?.axes ?? [],
        password: m?.password,
      });
    }
  }
  targets.sort((a, b) => a.key.localeCompare(b.key));
  const picked = opts.limit ? targets.slice(0, opts.limit) : targets;

  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  const client = new Client({ name: 'golden', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);

  let files = {};
  let hoisted = {};
  let hoistedConflicts = [];
  let calls = 0;
  let errors = 0;
  const t0 = Date.now();

  // device_bash は 1 呼び出し 45 秒で切れる。途中まで採ったものを引き継ぐ。
  // 版が違うゴールデンに継ぎ足すと 1 つの JSON に 2 つの版が混ざるので、そこで止まる。
  const outResolved = resolve(outPath);
  if (opts.resume && existsSync(outResolved)) {
    const prev = JSON.parse(readFileSync(outResolved, 'utf8'));
    if (stable(prev.header.deps) !== stable(depVersions())) {
      console.error(`--resume: 版が違う（${JSON.stringify(prev.header.deps)}）。継ぎ足すと 1 つの JSON に 2 つの版が混ざる。`);
      process.exit(2);
    }
    files = prev.files;
    hoisted = prev.header.hoisted;
    hoistedConflicts = prev.header.hoistedConflicts;
    calls = prev.header.counts.calls;
    errors = prev.header.counts.errors;
    console.error(`--resume: ${Object.keys(files).length} 件を引き継ぐ`);
  }

  const buildGolden = () => ({
    header: {
      formatVersion: 1,
      label: opts.label ?? basename(outPath, '.json'),
      capturedAt: new Date().toISOString(),
      node: process.version,
      deps: depVersions(),
      fixedArgs: FIXED_ARGS,
      tools: TOOLS,
      timeDependent: TIME_DEPENDENT,
      hoisted,
      hoistedConflicts,
      sets: sets.map((d) => ({
        token: setToken(d),
        root: relative(ROOT, d),
        files: picked.filter((t) => t.set === setToken(d)).length,
      })),
      counts: { files: Object.keys(files).length, calls, errors, ms: Date.now() - t0 },
    },
    files,
  });
  const flush = () => {
    mkdirSync(dirname(outResolved), { recursive: true });
    writeFileSync(outResolved, `${JSON.stringify(buildGolden())}\n`);
  };

  for (let i = 0; i < picked.length; i++) {
    const t = picked[i];
    if (files[t.key]) continue;
    const stat = statSync(t.path);
    const bytes = readFileSync(t.path);
    const entry = {
      set: t.set,
      bytes: stat.size,
      sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 32),
      axes: t.axes,
      tools: {},
    };
    for (const tool of TOOLS) {
      const args = { file_path: t.path, response_format: 'json', ...(FIXED_ARGS[tool] ?? {}) };
      if (t.password !== undefined) {
        // password を受け付けないツールに渡すと入力検証で落ちるので、受け付けるものだけ
        if (['verify_signatures', 'validate_conformance', 'evaluate_policy'].includes(tool)) {
          args.password = t.password;
        }
      }
      let res;
      try {
        res = await client.callTool({ name: tool, arguments: args });
      } catch (err) {
        // JSON-RPC エラーとして返った場合（SDK v2 はここに来る経路がある）
        res = { isError: true, content: [{ text: JSON.stringify({ rpcError: String(err) }) }], rpc: true };
      }
      calls++;
      const text = String(res.content?.[0]?.text ?? '');
      let raw;
      let parsed = true;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = { _text: text };
        parsed = false;
      }
      raw = maskPaths(raw, masks);
      const isError = res.isError === true;
      if (isError) errors++;

      for (const [t2, key] of HOISTED) {
        if (t2 === tool && !isError && raw && typeof raw === 'object' && key in raw) {
          const v = stable(raw[key]);
          const slot = `${tool}.${key}`;
          if (hoisted[slot] === undefined) hoisted[slot] = raw[key];
          else if (stable(hoisted[slot]) !== v) hoistedConflicts.push(`${t.key} ${slot}`);
          delete raw[key];
        }
      }

      entry.tools[tool] = {
        isError,
        parsed,
        channel: res.rpc ? 'jsonrpc' : 'tool-result',
        sha: sha(stable(raw)),
        kept: isError ? keptOfError(raw, text) : keptOf(tool, raw),
        raw,
      };
    }
    files[t.key] = entry;
    if ((i + 1) % 250 === 0) {
      flush();
      process.stderr.write(`  ${i + 1}/${picked.length} (${Date.now() - t0}ms)\n`);
    }
  }
  await client.close();

  const golden = buildGolden();
  flush();
  reportAxes(golden, outPath);
  return golden;
}

/**
 * 🔴 採るたびに軸を申告する。B1 の後退を捕まえたのはこの申告で、判定の A/B ではなかった。
 * 「1 形しか無い軸」は、その軸を持つ検体が集合に居ないことを意味する。
 */
function reportAxes(golden, outPath) {
  const files = Object.entries(golden.files);
  console.log(`\n採った: ${files.length} 検体 / ${golden.header.counts.calls} 呼び出し / ` +
    `${golden.header.counts.errors} 件が isError / ${golden.header.counts.ms}ms -> ${outPath}`);
  for (const s of golden.header.sets) console.log(`  集合 ${s.token}: ${s.files} 件  (${s.root})`);
  console.log(`  版: ${JSON.stringify(golden.header.deps)}`);
  let unparsed = 0;
  const unparsedFiles = new Set();
  for (const [k, e] of files) {
    for (const tool of TOOLS) {
      if (isUnparsed(e.tools[tool])) {
        unparsed++;
        unparsedFiles.add(`${k} / ${tool}`);
      }
    }
  }
  if (unparsed) {
    console.log(`\n  🔴 出力が JSON として読めなかった: ${unparsed} 件（切り詰めのため。ここでは項目を 1 つも取れていない）`);
    for (const k of unparsedFiles) console.log(`    ${k}`);
  }
  if (golden.header.hoistedConflicts.length) {
    console.log(`  🔴 ヘッダに寄せた項目がファイルごとに違う: ${golden.header.hoistedConflicts.length} 件`);
  }

  // 軸（manifest 由来）の分布
  const axisCount = {};
  for (const [, e] of files) for (const a of e.axes) axisCount[a] = (axisCount[a] ?? 0) + 1;
  const axes = Object.keys(axisCount).sort();
  console.log(`\n  申告した軸 (${axes.length}):`);
  for (const a of axes) console.log(`    ${a.padEnd(26)} ${axisCount[a]}`);

  // 1 形しか無い軸 = kept の中で、全検体を通して 1 つの値しか取らない信号
  const signals = {};
  const push = (k, v) => ((signals[k] ??= new Set()).add(stable(v)));
  /**
   * kept の値を「動いているか」を見られる形に均す。
   * 配列は数えない（行の集合は別の見方で見る）。
   * 辞書は 1 段ずつ降りる —— L1 の `observation` のように、鍵の下に信号が入る。
   * 降りずに捨てると、`observation` は 91 通りの値を取っているのに
   * 「1 形しか無い軸 = null」として報告される（実測。0.19.0 の基準を採るときに出た）。
   */
  const pushSignal = (k, v, depth = 0) => {
    if (Array.isArray(v)) return;
    if (v && typeof v === 'object') {
      if (depth >= 2) return;
      for (const [k2, v2] of Object.entries(v)) pushSignal(`${k}.${k2}`, v2, depth + 1);
      return;
    }
    push(k, v);
  };
  for (const [, e] of files) {
    for (const tool of TOOLS) {
      const t = e.tools[tool];
      if (!t) continue;
      push(`${tool}.isError`, t.isError);
      if (t.isError || !t.kept) continue;
      for (const [k, v] of Object.entries(t.kept)) pushSignal(`${tool}.${k}`, v);
    }
  }
  // 鍵の下にさらに信号がある軸（`observation` が null のときだけ葉になる等）は
  // 親を数えない。親は「その形が無かった」であって「動いていない」ではない。
  const keys = Object.keys(signals);
  const single = Object.entries(signals).filter(
    ([k, s]) => s.size <= 1 && !keys.some((o) => o.startsWith(`${k}.`)),
  );
  console.log(`\n  🔴 1 形しか無い軸 (${single.length}) —— この集合ではその軸が動いていない:`);
  for (const [k, s] of single) console.log(`    ${k.padEnd(40)} = ${[...s][0]}`);

  // 一度も fail しない制約 / 一度も違反にならない規則
  const seenConstraint = new Map();
  const seenRule = new Set();
  for (const [, e] of files) {
    const vc = e.tools.validate_clauses;
    if (vc && !vc.isError && vc.kept?.rows) {
      for (const [id, , status] of vc.kept.rows) {
        const cur = seenConstraint.get(id) ?? new Set();
        cur.add(status);
        seenConstraint.set(id, cur);
      }
    }
    const cf = e.tools.validate_conformance;
    if (cf && !cf.isError) for (const r of cf.kept?.violations ?? []) seenRule.add(r);
  }
  const neverFail = [...seenConstraint.entries()]
    .filter(([, s]) => !s.has('fail'))
    .map(([id]) => id)
    .sort();
  console.log(`\n  🔴 一度も fail しない制約 (${neverFail.length}/${seenConstraint.size}):`);
  console.log(`    ${neverFail.join(' ') || '(なし)'}`);
  console.log(`\n  違反として一度でも出た PDF/A・PDF/UA 規則 (${seenRule.size}):`);
  console.log(`    ${[...seenRule].sort().join(' ') || '(なし)'}`);
}

// --------------------------------------------------------------------------
// diff
// --------------------------------------------------------------------------

/** raw の深い比較。差の場所を JSON ポインタで名指しする。 */
function deepDiff(a, b, path = '', out = [], cap = 40) {
  if (out.length >= cap) return out;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) {
    out.push({ path: path || '/', before: brief(a), after: brief(b) });
    return out;
  }
  if (ta === 'array') {
    if (a.length !== b.length) out.push({ path: `${path}/length`, before: a.length, after: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) deepDiff(a[i], b[i], `${path}/${i}`, out, cap);
    return out;
  }
  if (ta === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]).values()) {
      if (!(k in a)) out.push({ path: `${path}/${k}`, before: undefined, after: brief(b[k]) });
      else if (!(k in b)) out.push({ path: `${path}/${k}`, before: brief(a[k]), after: undefined });
      else deepDiff(a[k], b[k], `${path}/${k}`, out, cap);
      if (out.length >= cap) break;
    }
    return out;
  }
  if (a !== b) out.push({ path: path || '/', before: a, after: b });
  return out;
}

function brief(v) {
  const s = stable(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

const B_A = 'A 読めた -> 読めない';
const B_B = 'B 読めない -> 読めた';
const B_C = 'C 判定が変わった（pass -> 非 pass）';
const B_D = 'D 🔴 反証できなくなった（fail -> pass、規則や対象の数が減る）';
const B_E = 'E 観測できた対象が減った';
const B_F = 'F 観測できた対象が増えた';
const B_G = 'G その他（帰属が要る）';
const B_H = 'H 🔴 出力が切り詰められて JSON にならない（項目を 1 つも取れていない）';
const B_I = 'I 並びだけが違う（行の集合と中身は同じ）';
const B_J = 'J 前の版に無かった項目が増えただけ（判定は動いていない）';
const BUCKETS = [B_A, B_B, B_D, B_C, B_E, B_F, B_H, B_I, B_J, B_G];

/**
 * 1 ファイル 1 ツールの差を、受入の表（§6 面 2）の行に割り当てる。
 * 🔴 **当てはまる行を全部返す。** 1 つに畳むと、原因（対象が減った）を
 * 結果（判定が変わった）が隠す —— L1 の `/Prev 0` の検体で実際にそうなった。
 */
function classify(tool, before, after) {
  if (isUnparsed(before) || isUnparsed(after)) return [B_H];
  if (!before.isError && after.isError) return [B_A];
  if (before.isError && !after.isError) return [B_B];
  if (before.isError && after.isError) return [B_G];
  const a = before.kept ?? {};
  const b = after.kept ?? {};
  const s = new Set();

  if (tool === 'validate_clauses') {
    const ma = new Map((a.rows ?? []).map((r) => [`${r[0]} ${r[1]}`, r[2]]));
    const mb = new Map((b.rows ?? []).map((r) => [`${r[0]} ${r[1]}`, r[2]]));
    for (const [k, va] of ma) {
      const vb = mb.get(k);
      if (vb === undefined) s.add(B_E);
      else if (va === 'fail' && (vb === 'pass' || vb === 'not_applicable')) s.add(B_D);
      else if (va === 'pass' && vb !== 'pass') s.add(B_C);
    }
    for (const k of mb.keys()) if (!ma.has(k)) s.add(B_F);
    if ((a.subjects ?? 0) > (b.subjects ?? 0)) s.add(B_E);
    if ((a.subjects ?? 0) < (b.subjects ?? 0)) s.add(B_F);
  }

  if (tool === 'validate_conformance') {
    if ((a.checkedRules ?? 0) > (b.checkedRules ?? 0)) s.add(B_D);
    if ((a.violations ?? []).length > (b.violations ?? []).length) s.add(B_D);
    if (a.compliant === false && b.compliant !== false) s.add(B_D);
    if (a.compliant !== false && b.compliant === false) s.add(B_C);
    if ((a.checkedRules ?? 0) < (b.checkedRules ?? 0)) s.add(B_F);
  }

  if (tool === 'verify_signatures') {
    const ma = new Map((a.sigs ?? []).map((x) => [x.field, x]));
    const mb = new Map((b.sigs ?? []).map((x) => [x.field, x]));
    if (ma.size > mb.size) s.add(B_E);
    if (ma.size < mb.size) s.add(B_F);
    for (const [k, va] of ma) {
      const vb = mb.get(k);
      if (!vb) continue;
      if (va.verdict === 'valid' && vb.verdict !== 'valid') s.add(B_C);
      if (va.verdict === 'invalid' && vb.verdict === 'valid') s.add(B_D);
    }
  }

  if (tool === 'verify_integrity') {
    if ((a.revisions ?? 0) > (b.revisions ?? 0)) s.add(B_E);
    if ((a.revisions ?? 0) < (b.revisions ?? 0)) s.add(B_F);
    if ((a.laterChanges ?? 0) > (b.laterChanges ?? 0)) s.add(B_D);
  }

  if (tool === 'evaluate_policy') {
    const rank = { reject: 0, human_review_required: 1, use_with_caution: 2, trust_and_use: 3 };
    const ra = rank[a.verdict] ?? -1;
    const rb = rank[b.verdict] ?? -1;
    if (rb > ra) s.add(B_D);
    if (rb < ra) s.add(B_C);
    if ((a.fired ?? []).length > (b.fired ?? []).length) s.add(B_D);
  }

  if (tool === 'detect_pades_level') {
    if ((a.count ?? 0) > (b.count ?? 0)) s.add(B_E);
    if ((a.count ?? 0) < (b.count ?? 0)) s.add(B_F);
  }

  // 行の集合と中身が同じで並びだけ違う場合は、そう名指しする（変化と混ぜない）
  if (tool === 'validate_clauses' && s.size === 0) {
    const key = (r) => stable(r);
    const sa = (a.rows ?? []).map(key).sort().join('|');
    const sb = (b.rows ?? []).map(key).sort().join('|');
    if (sa === sb && stable(a.rows) !== stable(b.rows)) s.add(B_I);
  }

  // 出力に項目が増えただけ（前の版に無かったキーしか差が無い）なら、判定は動いていない。
  // 版を上げると新しい項目が全件に乗るので、これを分けないと本当の差が埋もれる
  // —— L1 で `observation` を足したとき、2,947 件が「その他」に落ちた。
  if (s.size === 0) {
    const d = deepDiff(before.raw, after.raw, '', [], 200);
    if (d.length > 0 && d.length < 200 && d.every((x) => x.before === undefined)) s.add(B_J);
  }

  if (s.size === 0) return [B_G];
  return BUCKETS.filter((name) => s.has(name));
}

function diff(beforePath, afterPath, opts) {
  const A = JSON.parse(readFileSync(resolve(beforePath), 'utf8'));
  const B = JSON.parse(readFileSync(resolve(afterPath), 'utf8'));

  console.log(`before: ${A.header.label}  ${A.header.capturedAt}  ${JSON.stringify(A.header.deps)}`);
  console.log(`after : ${B.header.label}  ${B.header.capturedAt}  ${JSON.stringify(B.header.deps)}`);
  for (const slot of new Set([...Object.keys(A.header.hoisted), ...Object.keys(B.header.hoisted)])) {
    const va = stable(A.header.hoisted[slot]);
    const vb = stable(B.header.hoisted[slot]);
    if (va !== vb) console.log(`  版（ヘッダ） ${slot}: ${va} -> ${vb}`);
  }

  const ka = Object.keys(A.files);
  const kb = Object.keys(B.files);
  const setA = new Set(ka);
  const setB = new Set(kb);
  const removed = ka.filter((k) => !setB.has(k));
  const added = kb.filter((k) => !setA.has(k));
  console.log(`\n検体: before ${ka.length} / after ${kb.length}` +
    (removed.length || added.length
      ? `  （消えた ${removed.length} / 増えた ${added.length}）`
      : '  （同じ集合）'));
  for (const k of removed.slice(0, 10)) console.log(`  - ${k}`);
  for (const k of added.slice(0, 10)) console.log(`  + ${k}`);

  if (opts.detail) {
    const a = A.files[opts.detail];
    const b = B.files[opts.detail];
    if (!a || !b) {
      console.error(`--detail: ${opts.detail} が片方に無い`);
      process.exit(2);
    }
    let shown = 0;
    for (const tool of TOOLS) {
      if (a.tools[tool].sha === b.tools[tool].sha) continue;
      shown++;
      console.log(`\n=== ${opts.detail} / ${tool}  (${classify(tool, a.tools[tool], b.tools[tool]).join(' + ')})`);
      console.log(`isError ${a.tools[tool].isError} -> ${b.tools[tool].isError}`);
      for (const d of deepDiff(a.tools[tool].raw, b.tools[tool].raw, '', [], 200)) {
        console.log(`  ${d.path}\n    - ${d.before}\n    + ${d.after}`);
      }
    }
    if (!shown) console.log('\nこのファイルには差が無い');
    return shown || removed.length || added.length ? 1 : 0;
  }

  const byBucket = new Map(BUCKETS.map((n) => [n, []]));
  const byTool = {};
  let changed = 0;
  for (const k of ka) {
    if (!setB.has(k)) continue;
    const a = A.files[k];
    const b = B.files[k];
    if (a.sha256 !== b.sha256) {
      byBucket.get(B_G).push(`${k} [検体のバイト列が違う]`);
      changed++;
      continue;
    }
    for (const tool of TOOLS) {
      const ta = a.tools[tool];
      const tb = b.tools[tool];
      if (!ta || !tb || ta.sha === tb.sha) continue;
      changed++;
      byTool[tool] = (byTool[tool] ?? 0) + 1;
      for (const name of classify(tool, ta, tb)) byBucket.get(name).push(`${k} / ${tool}`);
    }
  }

  console.log(`\n差: ${changed} 件（ファイル×ツール）。` +
    '下の分類は重複する —— 1 件が複数の行に当たることがある');
  for (const [tool, n] of Object.entries(byTool).sort((x, y) => y[1] - x[1])) {
    console.log(`  ${tool.padEnd(22)} ${n}`);
  }
  console.log('');
  const max = opts.max ?? 12;
  for (const name of BUCKETS) {
    const list = byBucket.get(name);
    if (!list.length) continue;
    console.log(`${name}: ${list.length}`);
    for (const l of list.slice(0, max)) console.log(`    ${l}`);
    if (list.length > max) console.log(`    … 残り ${list.length - max} 件（--max で増やす）`);
  }
  if (!changed && !removed.length && !added.length) console.log('差なし');
  return changed || removed.length || added.length ? 1 : 0;
}

// --------------------------------------------------------------------------
// t3 — 計器自身を壊して、差が出ることを実測する。採る前に通す
// --------------------------------------------------------------------------

function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  let code;
  try {
    code = fn();
  } finally {
    console.log = orig;
  }
  return { code, text: lines.join('\n') };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

/** raw を書き換えたら kept と sha を採り直す。片方だけ動かすと計器が嘘をつく。 */
function refresh(entry, tool) {
  entry.kept = entry.isError ? entry.kept : keptOf(tool, entry.raw);
  entry.sha = sha(stable(entry.raw));
}

function t3(goldenPath) {
  const src = JSON.parse(readFileSync(resolve(goldenPath), 'utf8'));
  // 壊した写しは使い捨てなので、マウント（ユーザのディスク）ではなく VM の一時領域に置く
  const tmp = join(process.env.TMPDIR || '/tmp', 'pdf-verify-golden-t3');
  mkdirSync(tmp, { recursive: true });
  const write = (name, obj) => {
    const p = join(tmp, `${name}.json`);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };
  const base = write('base', src);

  const keys = Object.keys(src.files);
  const findWhere = (pred) => keys.find((k) => pred(src.files[k]));

  const cases = [];
  const add = (name, mutate, expect) => cases.push({ name, mutate, expect });

  add('0 空振り（同じものを比べる）', (g) => g, (t) => t.includes('差なし'));

  const okKey = findWhere((f) => TOOLS.every((t) => !f.tools[t].isError));
  const errKey = findWhere((f) => f.tools.detect_pades_level.isError);
  const clauseKey = findWhere(
    (f) => !f.tools.validate_clauses.isError && (f.tools.validate_clauses.kept?.rows?.length ?? 0) > 2,
  );
  const failKey = findWhere(
    (f) =>
      !f.tools.validate_clauses.isError &&
      (f.tools.validate_clauses.kept?.rows ?? []).some((r) => r[2] === 'fail'),
  );
  const passKey = findWhere(
    (f) =>
      !f.tools.validate_clauses.isError &&
      (f.tools.validate_clauses.kept?.rows ?? []).some((r) => r[2] === 'pass'),
  );
  const confKey = findWhere(
    (f) => !f.tools.validate_conformance.isError && (f.tools.validate_conformance.kept?.checkedRules ?? 0) > 1,
  );

  // 🔴 空振り検査の対: 壊す先が集合に無いなら、その検査は「通った」のではなく「何も測っていない」
  const required = { okKey, errKey, clauseKey, failKey, passKey, confKey };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);

  add('1 読めた -> 読めない（isError を立てる）', (g) => {
    const e = g.files[okKey].tools.detect_pades_level;
    e.isError = true;
    e.raw = { code: 'PARSE_FAILED', message: 'ISO 32000-1 7.5.4' };
    e.kept = keptOfError(e.raw, e.raw.message);
    e.sha = sha(stable(e.raw));
    return g;
  }, (t) => /^A 読めた -> 読めない: 1$/m.test(t));

  add('2 読めない -> 読めた（isError を落とす）', (g) => {
    const e = g.files[errKey].tools.detect_pades_level;
    e.isError = false;
    e.raw = [];
    refresh(e, 'detect_pades_level');
    return g;
  }, (t) => /^B 読めない -> 読めた: 1$/m.test(t));

  add('3 pass -> fail（判定が変わった）', (g) => {
    const e = g.files[passKey].tools.validate_clauses;
    const row = e.raw.results.find((r) => r.status === 'pass');
    row.status = 'fail';
    refresh(e, 'validate_clauses');
    return g;
  }, (t) => /^C 判定が変わった/m.test(t));

  add('4 🔴 fail -> pass（反証できなくなった）', (g) => {
    const e = g.files[failKey].tools.validate_clauses;
    const row = e.raw.results.find((r) => r.status === 'fail');
    row.status = 'pass';
    refresh(e, 'validate_clauses');
    return g;
  }, (t) => /^D 🔴 反証できなくなった/m.test(t));

  add('5 制約の行を 1 つ落とす（観測できた対象が減った）', (g) => {
    const e = g.files[clauseKey].tools.validate_clauses;
    e.raw.results.pop();
    refresh(e, 'validate_clauses');
    return g;
  }, (t) => /^E 観測できた対象が減った/m.test(t));

  add('6 🔴 checkedRules を 1 減らす（規則の数が減る）', (g) => {
    const e = g.files[confKey].tools.validate_conformance;
    e.raw.checkedRules -= 1;
    refresh(e, 'validate_conformance');
    return g;
  }, (t) => /^D 🔴 反証できなくなった/m.test(t));

  add('7 kept に無い項目だけ動かす（sha で出る）', (g) => {
    const e = g.files[okKey].tools.identify_conformance;
    e.raw.notes = [...(e.raw.notes ?? []), 'T-3'];
    refresh(e, 'identify_conformance');
    return g;
  }, (t) => /identify_conformance/.test(t) && /差: [1-9]/.test(t));

  add('8 版（ヘッダに寄せた項目）だけ動かす', (g) => {
    g.header.hoisted['validate_clauses.constraintsVersion'] = '9.9.9';
    return g;
  }, (t) => /版（ヘッダ） validate_clauses\.constraintsVersion/.test(t) && /差: 0 件/.test(t));

  add('10 🔴 出力を JSON にならない形にする（切り詰め）', (g) => {
    const e = g.files[clauseKey].tools.validate_clauses;
    e.raw = { _text: '{ "constraintsVersion": "0.3.0", "resu' };
    e.parsed = false;
    e.kept = keptOf('validate_clauses', {});
    e.sha = sha(stable(e.raw));
    return g;
  }, (t) => /^H 🔴 出力が切り詰められて/m.test(t));

  add('11 行の並びだけ入れ替える', (g) => {
    const e = g.files[clauseKey].tools.validate_clauses;
    e.raw.results = [...e.raw.results].reverse();
    refresh(e, 'validate_clauses');
    return g;
  }, (t) => /^I 並びだけが違う/m.test(t));

  add('12 出力に項目が増えただけ', (g) => {
    const e = g.files[okKey].tools.identify_conformance;
    e.raw.observation = { scope: 'T-3' };
    refresh(e, 'identify_conformance');
    return g;
  }, (t) => /^J 前の版に無かった項目が増えただけ/m.test(t));

  add('13 🔴 項目が増え、かつ判定も動いたときは J で終わらせない', (g) => {
    const e = g.files[passKey].tools.validate_clauses;
    e.raw.observation = { scope: 'T-3' };
    const row = e.raw.results.find((r) => r.status === 'pass');
    row.status = 'fail';
    refresh(e, 'validate_clauses');
    return g;
  }, (t) => /^C 判定が変わった/m.test(t) && !/^J 前の版に無かった項目が増えただけ: 1$/m.test(t));

  add('9 検体を 1 件落とす', (g) => {
    delete g.files[okKey];
    return g;
  }, (t) => /消えた 1 /.test(t));

  console.log(`計器の T-3: ${goldenPath}（検体 ${keys.length}）`);
  if (missing.length) {
    console.log(`🔴 壊す先が集合に無い検査がある: ${missing.join(' ')}`);
    console.log('   その検査は「通った」のではなく、何も測っていない。');
  }
  let failed = 0;
  for (const c of cases) {
    const mutated = c.mutate(clone(src));
    const p = write(`case-${c.name.split(' ')[0]}`, mutated);
    const { text } = capture(() => diff(base, p, {}));
    const ok = c.expect(text);
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : '🔴 NG'} ${c.name}`);
    if (!ok) console.log(text.split('\n').map((l) => `        ${l}`).join('\n'));
  }
  console.log(failed ? `\n🔴 ${failed} 件の自己検査に失敗` : `\n${cases.length} 件とも差を報告した`);
  return failed || missing.length ? 2 : 0;
}

// --------------------------------------------------------------------------
// CLI —— 🔴 知らない引数では止まる（B1 で既定の集合が黙って使われた）
// --------------------------------------------------------------------------

const USAGE = `使い方:
  node scripts/golden.mjs take <out.json> [--set <dir>]... [--label NAME] [--limit N] [--resume]
  node scripts/golden.mjs diff <before.json> <after.json> [--detail <file-key>] [--max N]
  node scripts/golden.mjs report <golden.json>
  node scripts/golden.mjs t3   [golden.json]`;

function parseArgs(argv) {
  const positional = [];
  const opts = { sets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') opts.sets.push(argv[++i]);
    else if (a === '--label') opts.label = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--resume') opts.resume = true;
    else if (a === '--detail') opts.detail = argv[++i];
    else if (a === '--max') opts.max = Number(argv[++i]);
    else if (a.startsWith('--')) {
      console.error(`知らない引数: ${a}\n${USAGE}`);
      process.exit(2);
    } else positional.push(a);
  }
  return { positional, opts };
}

const { positional, opts } = parseArgs(process.argv.slice(2));
const mode = positional[0];

if (mode === 'take') {
  if (!positional[1]) {
    console.error(USAGE);
    process.exit(2);
  }
  await take(positional[1], opts);
  process.exit(0);
} else if (mode === 'diff') {
  if (!positional[1] || !positional[2]) {
    console.error(USAGE);
    process.exit(2);
  }
  process.exit(diff(positional[1], positional[2], opts));
} else if (mode === 'report') {
  if (!positional[1]) {
    console.error(USAGE);
    process.exit(2);
  }
  reportAxes(JSON.parse(readFileSync(resolve(positional[1]), 'utf8')), positional[1]);
  process.exit(0);
} else if (mode === 't3') {
  const p = positional[1] ?? join(ROOT, '.golden/before-full.json');
  if (!existsSync(resolve(p))) {
    console.error(`t3 に渡すゴールデンが無い: ${p}\n先に take を 1 回だけ回す（--limit 60 でよい）`);
    process.exit(2);
  }
  process.exit(t3(p));
} else {
  console.error(USAGE);
  process.exit(2);
}
