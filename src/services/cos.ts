/**
 * COS の読み口。**ここに判定は書かない。**
 *
 * pdf-lib の `instanceof PDFDict` / `context.lookup` に当たるものを 1 か所に集める。
 * 6 ファイルに散らすと同じ変換が 6 通りになり、そのうち 1 つだけ条文の読み方が違う、
 * という形で壊れる（B1 = pdf-constraints の撤去で実測。`src/facts/cos.ts` と同じ位置づけ）。
 *
 * 🔴 **「読めなかった」と「そこに無い」を分ける。** 未定義の間接参照は null と等価で
 * （R-7.3.10-13）、それは**観測できた事実**である。条文に反していて復号できないストリームは
 * 観測できていない。2 つを同じ `null` に畳むと、「フォントが埋め込まれていない」と
 * 「フォントを読めなかった」が同じ顔になる（B1 で一度そうして、唯一 fail していた検体を消した）。
 */

import {
  COS_NULL,
  type CosArray,
  type CosDict,
  type CosObject,
  type CosRef,
  type CosStream,
  decodeStream,
  decodeTextString,
  dictGet,
  type PdfDocument,
} from 'normativepdf';

/* ------------------------------------------------------------------ *
 * 形を見る（pdf-lib の instanceof に当たる）
 * ------------------------------------------------------------------ */

export function asDict(value: CosObject | undefined | null): CosDict | null {
  return value?.kind === 'dict' ? value : null;
}

export function asStream(value: CosObject | undefined | null): CosStream | null {
  return value?.kind === 'stream' ? value : null;
}

export function asArray(value: CosObject | undefined | null): CosArray | null {
  return value?.kind === 'array' ? value : null;
}

export function asRef(value: CosObject | undefined | null): CosRef | null {
  return value?.kind === 'ref' ? value : null;
}

/**
 * ストリームの辞書。**ストリームは辞書ではない。**
 * pdf-lib の `enumerateIndirectObjects` を `instanceof PDFDict` で絞ると
 * `PDFRawStream` は落ちる —— その範囲を変えると、いままで見ていなかった辞書が
 * 規則の対象に入って判定が動く。範囲を変えるなら別の変更として測ること。
 */
export function dictOfStream(value: CosObject | undefined | null): CosDict | null {
  return value?.kind === 'stream' ? value.dict : null;
}

/** 名前オブジェクトの値（`#xx` の解決と UTF-8 復号は lexer が済ませている・R-7.3.5-13）。 */
export function nameOf(value: CosObject | undefined | null): string | null {
  return value?.kind === 'name' ? value.value : null;
}

/** 数値（整数と実数のどちらでも受ける）。 */
export function numberOf(value: CosObject | undefined | null): number | null {
  return value?.kind === 'integer' || value?.kind === 'real' ? value.value : null;
}

/** 整数だけを受ける（R-7.3.3-6「実数が来てはならない」を区別できるようにしておく）。 */
export function integerOf(value: CosObject | undefined | null): number | null {
  return value?.kind === 'integer' ? value.value : null;
}

export function boolOf(value: CosObject | undefined | null): boolean | null {
  return value?.kind === 'boolean' ? value.value : null;
}

/** 文字列のバイト列そのまま（復号は §7.9.2 の話で、ここではしない）。 */
export function bytesOf(value: CosObject | undefined | null): Uint8Array | null {
  return value?.kind === 'string' ? value.bytes : null;
}

/**
 * テキスト文字列（§7.9.2）。PDFDocEncoding / UTF-16BE / UTF-8（PDF 2.0）を
 * 見分けて復号し、言語エスケープ列を落とす。
 * pdf-lib 1.x は `R-7.9.2.2.1-4`（UTF-8 のバイト順マーク）を実装しておらず、
 * 適合している文書に「文法に合わない」と誤報していた。
 */
export function textOf(value: CosObject | undefined | null): string | null {
  const bytes = bytesOf(value);
  return bytes === null ? null : decodeTextString(bytes);
}

/* ------------------------------------------------------------------ *
 * 辞書を引く
 * ------------------------------------------------------------------ */

/** 直接値を引く（`null` の値は「無い」と等価に畳む・R-7.3.7-7）。参照は解決しない。 */
export function get(dict: CosDict | null, key: string): CosObject | undefined {
  return dict ? dictGet(dict, key) : undefined;
}

/** 鍵があるか。**値が `null` でも「ある」と数える**（`get` とはここが違う）。 */
export function has(dict: CosDict | null, key: string): boolean {
  return dict ? dict.entries.has(key) : false;
}

/**
 * 引いて解決する。**読めたかどうかを分けて返す。**
 *
 * - `{ value: X, unreadable: false }` —— 読めた（`null` は「未定義の間接参照」= 観測できた事実）
 * - `{ value: null, unreadable: true }` —— **観測できなかった**。オブジェクトストリームが
 *   条文に反して復号できない、などがここに来る。判定に食わせてはいけない
 */
export interface Lookup {
  value: CosObject | null;
  unreadable: boolean;
}

export async function tryResolve(doc: PdfDocument, value: CosObject | undefined): Promise<Lookup> {
  if (value === undefined) return { value: null, unreadable: false };
  try {
    const resolved = await doc.resolve(value);
    return { value: resolved.kind === 'null' ? null : resolved, unreadable: false };
  } catch {
    return { value: null, unreadable: true };
  }
}

/** 辞書の鍵を引いて解決する。 */
export async function tryGet(doc: PdfDocument, dict: CosDict | null, key: string): Promise<Lookup> {
  return tryResolve(doc, get(dict, key));
}

/** 読めなかったことを捨ててよい場所だけで使う短縮形（`unreadable` は `null` に畳まれる）。 */
export async function resolved(
  doc: PdfDocument,
  value: CosObject | undefined,
): Promise<CosObject | null> {
  return (await tryResolve(doc, value)).value;
}

/* ------------------------------------------------------------------ *
 * オブジェクトを数え上げる
 * ------------------------------------------------------------------ */

export interface IndirectEntry {
  objectNumber: number;
  generation: number;
  object: CosObject;
}

/**
 * 相互参照表に載っている間接オブジェクトを、番号順に読む。
 * 読めなかったものは**飛ばさずに数える**（`unreadable` として返る）。
 */
export async function enumerateObjects(
  doc: PdfDocument,
): Promise<{ objects: IndirectEntry[]; unreadable: number }> {
  const objects: IndirectEntry[] = [];
  let unreadable = 0;
  const numbers = [...doc.xref.keys()].sort((a, b) => a - b);
  for (const objectNumber of numbers) {
    if (objectNumber === 0) continue;
    const entry = doc.xref.get(objectNumber);
    if (!entry || entry.type === 'free' || entry.type === 'unknown') continue;
    const generation = entry.type === 'in-use' ? entry.generation : 0;
    try {
      const object = await doc.getObject(objectNumber, generation);
      if (object.kind === 'null') continue;
      objects.push({ objectNumber, generation, object });
    } catch {
      unreadable += 1;
    }
  }
  return { objects, unreadable };
}

/**
 * 間接オブジェクトのうち**辞書だけ**（ストリームの辞書は含めない）。
 * pdf-lib の `enumerateIndirectObjects()` + `instanceof PDFDict` と同じ範囲である。
 * 🔴 ここにストリームを足すと、いままで見ていなかった辞書が規則の対象に入る。
 */
export async function enumerateDicts(
  doc: PdfDocument,
): Promise<{ dicts: CosDict[]; unreadable: number }> {
  const { objects, unreadable } = await enumerateObjects(doc);
  const dicts: CosDict[] = [];
  for (const { object } of objects) if (object.kind === 'dict') dicts.push(object);
  return { dicts, unreadable };
}

/* ------------------------------------------------------------------ *
 * ストリームの中身
 * ------------------------------------------------------------------ */

/**
 * ストリームを復号する。**読めなかったら `unreadable`** —— 空のバイト列にしない。
 * 空を返すと「中身が無い」と「読めなかった」が同じ顔になる。
 *
 * 🔴 `/Length` `/Filter` `/DecodeParms` は間接参照でよい（相互参照ストリームだけは
 * 直接であることを §7.5.8.2 が要求している）。`decodeStream` は同期の解決関数しか
 * 受け取れないので、辞書の第 1 階層の参照を**先に解いてから**渡す。
 * これを渡さないと、`/Length 12 0 R` の DSS 証明書ストリームなどが「読めない」に落ち、
 * 失効情報がまるごと消える —— 実検体で `revocation: revoked` が `unknown` に化けた。
 */
export async function decodedBytes(
  doc: PdfDocument,
  stream: CosStream | null,
): Promise<{ bytes: Uint8Array | null; unreadable: boolean }> {
  if (!stream) return { bytes: null, unreadable: false };
  const cache = new Map<string, CosObject>();
  for (const [, value] of stream.dict.entries) {
    if (value.kind !== 'ref') continue;
    const key = `${value.objectNumber} ${value.generationNumber}`;
    if (cache.has(key)) continue;
    try {
      cache.set(key, await doc.resolve(value));
    } catch {
      cache.set(key, COS_NULL);
    }
  }
  const resolve = (value: CosObject): CosObject =>
    value.kind === 'ref'
      ? (cache.get(`${value.objectNumber} ${value.generationNumber}`) ?? COS_NULL)
      : value;
  try {
    return { bytes: await decodeStream(stream, { resolve }), unreadable: false };
  } catch {
    return { bytes: null, unreadable: true };
  }
}
