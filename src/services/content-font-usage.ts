/**
 * コンテンツストリームを演算子まで読み、**どのフォントがどのテキスト
 * レンダリングモードで文字を出したか**を集める。
 *
 * **なぜ要るか**（2026-08-29 実測）: `fonts-embedded` は文書中の `/Type /Font` 辞書を
 * 数え上げているだけで、そのフォントが実際に使われたかを見ていなかった。
 * PDF/A が埋め込みを求めるのは**描画に使われたフォント**である。独立オラクル
 * （veraPDF 1.30.2）と突き合わせると、こちらだけが違反と言っている検体が
 * **106 件中 88 件**あった:
 *
 *   87 件  どこでも文字を出していない（AcroForm の `/DR` に居るだけの `/Helv` `/ZaDb` など）
 *    1 件  テキストレンダリングモード 3（不可視・ISO 32000-2 §9.3.6）でしか出していない
 *
 * 決め手は veraPDF 自身の検体 `6-2-10-4-1-t01-{pass,fail}-a.pdf` で、
 * 2 つは **`3 Tr` という演算子 1 つだけ**が違い、フォント記述子はどちらも
 * `/FontFile3 null` で同一である。veraPDF は pass / fail に分ける。
 *
 * 🔴 **ここは判定を書かない。** 返すのは「どのモードで出したか」の観測だけで、
 * 「適合しているか」ではない。観測しきれなかったときは `incomplete` を立てる ——
 * 黙って「使われていない」に寄せると、埋め込み違反を見逃す側に倒れる。
 *
 * 🔴 **置き場所は verify の中**（2026-08-29 決定）。演算子読みは ADR-0009 §6 が
 * 「コア側の需要駆動候補として記録するに留める。着火は実需要を待つ」と書いたもので、
 * 今回が実需要の 1 つ目である。据え置きではなく保留で、**reader の pdf-lib 撤去
 * （第 3 弾）で需要が 2 つになった時点**で、コアへ起こすかを ADR として決め直す。
 */

import {
  asArray,
  asDict,
  asStream,
  decodedBytes,
  get,
  nameOf,
  resolved,
} from '@normativepdf/recover';
import type { CosDict, CosObject, CosStream, PdfDocument } from 'normativepdf';
import { readPageTree } from 'normativepdf';

/** フォームやパターンをどこまで降りるか。これより深いものは観測しきれていない */
const MAX_DEPTH = 4;

const SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);
const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'op'; value: string }
  | { kind: 'other' };

/**
 * コンテンツストリームを字句に割る。
 *
 * **値は要らない** —— 要るのは演算子と、その直前に積まれた名前・数だけなので、
 * 文字列や辞書は中身を読まずに飛ばす。ただし**飛ばす長さを間違えると演算子がずれる**
 * ので、括弧の入れ子とエスケープだけは正しく数える。
 */
function* tokenize(bytes: Uint8Array): Generator<Token> {
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const c = bytes[i];
    if (WHITESPACE.has(c)) {
      i += 1;
      continue;
    }
    if (c === 0x25) {
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i += 1;
      continue;
    }
    if (c === 0x28) {
      let depth = 1;
      i += 1;
      while (i < n && depth > 0) {
        if (bytes[i] === 0x5c) {
          i += 2;
          continue;
        }
        if (bytes[i] === 0x28) depth += 1;
        else if (bytes[i] === 0x29) depth -= 1;
        i += 1;
      }
      yield { kind: 'other' };
      continue;
    }
    if (c === 0x3c && bytes[i + 1] === 0x3c) {
      i += 2;
      yield { kind: 'other' };
      continue;
    }
    if (c === 0x3e && bytes[i + 1] === 0x3e) {
      i += 2;
      yield { kind: 'other' };
      continue;
    }
    if (c === 0x3c) {
      i += 1;
      while (i < n && bytes[i] !== 0x3e) i += 1;
      i += 1;
      yield { kind: 'other' };
      continue;
    }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      i += 1;
      yield { kind: 'other' };
      continue;
    }
    if (c === 0x2f) {
      i += 1;
      const start = i;
      while (i < n && !WHITESPACE.has(bytes[i]) && !DELIMITERS.has(bytes[i])) i += 1;
      yield { kind: 'name', value: latin1(bytes, start, i) };
      continue;
    }
    const start = i;
    while (i < n && !WHITESPACE.has(bytes[i]) && !DELIMITERS.has(bytes[i])) i += 1;
    if (i === start) {
      i += 1;
      continue;
    }
    const text = latin1(bytes, start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) yield { kind: 'number', value: Number(text) };
    else yield { kind: 'op', value: text };
  }
}

function latin1(bytes: Uint8Array, from: number, to: number): string {
  let out = '';
  for (let k = from; k < to; k += 1) out += String.fromCharCode(bytes[k]);
  return out;
}

/**
 * 1 本のコンテンツストリームを走り、`資源名 -> 出したモードの集合` を足す。
 * `q` / `Q` はテキスト状態も積む（`Tf` も `Tr` もグラフィックス状態の一部・§8.4）。
 */
function scanStream(
  bytes: Uint8Array,
  seen: Map<string, Set<number>>,
  onForm: (name: string) => void,
): void {
  const stack: Array<[string | null, number]> = [];
  let font: string | null = null;
  let mode = 0;
  let operands: Token[] = [];
  for (const token of tokenize(bytes)) {
    if (token.kind !== 'op') {
      operands.push(token);
      if (operands.length > 64) operands.shift();
      continue;
    }
    const op = token.value;
    if (op === 'q') stack.push([font, mode]);
    else if (op === 'Q') {
      const saved = stack.pop();
      if (saved) [font, mode] = saved;
    } else if (op === 'Tf') {
      const name = [...operands].reverse().find((o) => o.kind === 'name');
      font = name && name.kind === 'name' ? name.value : null;
    } else if (op === 'Tr') {
      const num = [...operands].reverse().find((o) => o.kind === 'number');
      if (num && num.kind === 'number') mode = num.value;
    } else if (op === 'Do') {
      const name = [...operands].reverse().find((o) => o.kind === 'name');
      if (name && name.kind === 'name') onForm(name.value);
    } else if (SHOW_OPS.has(op)) {
      const key = font ?? '';
      const set = seen.get(key) ?? new Set<number>();
      set.add(mode);
      seen.set(key, set);
    }
    operands = [];
  }
}

/** ページの `/Contents`（ストリーム 1 つでも配列でも）を 1 本のバイト列にする */
async function contentBytes(
  doc: PdfDocument,
  contents: CosObject | undefined,
): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let unreadable = false;
  const push = async (value: CosObject | undefined): Promise<void> => {
    const stream = asStream(await resolved(doc, value));
    if (!stream) return;
    // 🔴 読めなかったことを空のバイト列に畳まない —— 畳むと
    // 「文字を出していない」と「読めなかった」が同じ顔になる
    const decoded = await decodedBytes(doc, stream).catch(() => ({
      bytes: null,
      unreadable: true,
    }));
    if (decoded.unreadable || decoded.bytes === null) unreadable = true;
    else chunks.push(decoded.bytes);
  };
  const array = asArray(await resolved(doc, contents));
  if (array) for (const item of array.items) await push(item);
  else await push(contents);
  if (unreadable) return null;
  const total = chunks.reduce((sum, c) => sum + c.length + 1, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
    out[at] = 0x0a;
    at += 1;
  }
  return out;
}

/** `/Resources /Font` の名前 → フォント辞書 */
async function fontResources(
  doc: PdfDocument,
  resources: CosDict | null,
): Promise<Map<string, CosDict>> {
  const out = new Map<string, CosDict>();
  const fonts = asDict(await resolved(doc, get(resources, 'Font')));
  if (!fonts) return out;
  for (const [name, value] of fonts.entries) {
    const dict = asDict(await resolved(doc, value));
    if (dict) out.set(name, dict);
  }
  return out;
}

export interface FontUsage {
  /** フォント辞書 → そのフォントが文字を出したときのモードの集合 */
  usage: Map<CosDict, Set<number>>;
  /**
   * 🔴 観測しきれなかった。**この状態で「使われていない」と結論しない。**
   * 読めないコンテンツ・解決できない資源名・深すぎる入れ子がここに来る。
   */
  incomplete: boolean;
  /** 何が観測できなかったか（報告に出す） */
  reasons: string[];
}

/**
 * 文書全体で、フォントがどのモードで文字を出したかを集める。
 *
 * 走る範囲: ページのコンテンツ、フォーム XObject（深さ {@link MAX_DEPTH} まで）、
 * 注釈の外観ストリーム `/AP /N`（§12.5.5。フォーム欄の値はここにある）。
 *
 * **走っていない範囲**（`incomplete` になる）: Type3 フォントの CharProcs、
 * タイリングパターンの内容、ExtGState の `/SMask` が指すグループ、
 * {@link MAX_DEPTH} より深いフォーム。
 */
export async function collectFontUsage(doc: PdfDocument): Promise<FontUsage> {
  const usage = new Map<CosDict, Set<number>>();
  const reasons = new Set<string>();

  const tree = await readPageTree({
    resolve: (value) => doc.resolve(value),
    getCatalog: () => doc.getCatalog(),
  }).catch(() => null);
  if (!tree) {
    return { usage, incomplete: true, reasons: ['page tree not reachable'] };
  }
  if (!tree.reached) reasons.add('page tree not fully reachable');

  const record = (dict: CosDict, modes: Set<number>): void => {
    const set = usage.get(dict) ?? new Set<number>();
    for (const mode of modes) set.add(mode);
    usage.set(dict, set);
  };

  const walk = async (
    resources: CosDict | null,
    contents: CosObject | CosStream | undefined,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_DEPTH) {
      reasons.add(`form nesting deeper than ${MAX_DEPTH}`);
      return;
    }
    const bytes = await contentBytes(doc, contents as CosObject | undefined);
    if (bytes === null) {
      reasons.add('content stream could not be decoded');
      return;
    }
    const byName = await fontResources(doc, resources);
    const seen = new Map<string, Set<number>>();
    const forms: string[] = [];
    scanStream(bytes, seen, (name) => forms.push(name));
    for (const [name, modes] of seen) {
      const dict = byName.get(name);
      if (!dict) {
        // 名前を解決できない = そのフォントを観測できていない
        reasons.add('font resource name could not be resolved');
        continue;
      }
      record(dict, modes);
    }
    const xobjects = asDict(await resolved(doc, get(resources, 'XObject')));
    for (const name of forms) {
      const stream = asStream(await resolved(doc, get(xobjects, name)));
      if (!stream) {
        reasons.add('XObject could not be resolved');
        continue;
      }
      if (nameOf(get(stream.dict, 'Subtype')) !== 'Form') continue;
      const own = asDict(await resolved(doc, get(stream.dict, 'Resources')));
      await walk(own ?? resources, stream as unknown as CosObject, depth + 1);
    }
  };

  for (const page of tree.pages) {
    const dict = asDict(page.dict);
    if (!dict) {
      reasons.add('page dictionary could not be read');
      continue;
    }
    let resources = asDict(await resolved(doc, get(dict, 'Resources')));
    if (!resources) {
      // `/Resources` はページに無ければ祖先から継ぐ（§7.7.3.4）
      for (const ancestor of [...(page.ancestors ?? [])].reverse()) {
        resources = asDict(await resolved(doc, get(asDict(ancestor), 'Resources')));
        if (resources) break;
      }
    }
    await walk(resources, get(dict, 'Contents'), 0);

    const annots = asArray(await resolved(doc, get(dict, 'Annots')));
    for (const item of annots?.items ?? []) {
      const annot = asDict(await resolved(doc, item));
      if (!annot) {
        reasons.add('annotation could not be read');
        continue;
      }
      const ap = asDict(await resolved(doc, get(annot, 'AP')));
      if (!ap) continue;
      const normal = await resolved(doc, get(ap, 'N'));
      const streams: CosStream[] = [];
      const direct = asStream(normal);
      if (direct) streams.push(direct);
      else {
        // `/N` は状態名 -> ストリームの辞書でもある（§12.5.5）
        const states = asDict(normal);
        for (const [, value] of states?.entries ?? []) {
          const stream = asStream(await resolved(doc, value));
          if (stream) streams.push(stream);
          else reasons.add('appearance stream could not be resolved');
        }
      }
      for (const stream of streams) {
        const own = asDict(await resolved(doc, get(stream.dict, 'Resources')));
        await walk(own ?? resources, stream as unknown as CosObject, 1);
      }
    }
  }

  return { usage, incomplete: reasons.size > 0, reasons: [...reasons] };
}
