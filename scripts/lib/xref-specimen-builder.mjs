/**
 * 相互参照チェーンの止まり方を狙って作るための、最小の PDF 組み立て。
 *
 * qpdf も pdf-lib も使わない —— 相互参照節の 1 バイトまでこちらが決めないと、
 * 狙った `XrefChainStop` に当たらない。副作用は持たない（検体を書き出すのは
 * `scripts/golden-specimens-xref.mjs`、同じものをテストも読む）。
 */

/** 相互参照表の 1 行は正確に 20 バイト（§7.5.4）。EOL は SP CR LF の 2 文字ぶん。 */
export const xrefEntry = (offset, gen, type) =>
  `${String(offset).padStart(10, '0')} ${String(gen).padStart(5, '0')} ${type}\r\n`;

const CATALOG = '<< /Type /Catalog /Pages 2 0 R >>';
const PAGES = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
const page = (side) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${side} ${side}] >>`;

/** オブジェクトを順に並べ、各オブジェクトの先頭バイト位置を記録しながら組む。 */
function layout(header, objects) {
  let text = header;
  const offsets = new Map();
  for (const [num, body] of objects) {
    offsets.set(num, Buffer.byteLength(text, 'latin1'));
    text += `${num} 0 obj\n${body}\nendobj\n`;
  }
  return { text, offsets };
}

/** リビジョン 1 本の、条文どおりの文書。 */
export function baseRevision() {
  const { text, offsets } = layout('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', [
    [1, CATALOG],
    [2, PAGES],
    [3, page(200)],
  ]);
  const xrefAt = Buffer.byteLength(text, 'latin1');
  const body =
    `${text}xref\n0 4\n` +
    xrefEntry(0, 65535, 'f') +
    xrefEntry(offsets.get(1), 0, 'n') +
    xrefEntry(offsets.get(2), 0, 'n') +
    xrefEntry(offsets.get(3), 0, 'n') +
    `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return { body, xrefAt };
}

/**
 * 増分更新を 1 本足す。`prevValue` は新しい節の `/Prev` に置く文字列
 * （関数なら、その節自身の位置を受け取る）。ここに何を書くかが止まり方を決める。
 */
export function withUpdate(prevValue) {
  const first = baseRevision();
  const objAt = Buffer.byteLength(first.body, 'latin1');
  const updated = `3 0 obj\n${page(300)}\nendobj\n`;
  const xrefAt = objAt + Buffer.byteLength(updated, 'latin1');
  const prev = typeof prevValue === 'function' ? prevValue(xrefAt) : prevValue;
  const tail =
    `xref\n0 1\n${xrefEntry(0, 65535, 'f')}3 1\n${xrefEntry(objAt, 0, 'n')}` +
    `trailer\n<< /Size 4 /Root 1 0 R /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return first.body + updated + tail;
}

/** 狙う止まり方ごとの本文。名前は `XrefChainStop` の値に合わせてある。 */
export const specimens = {
  /** 条文どおりに読める素の文書。ほかの 3 つの対照（空振り検査の対）。 */
  complete: () => baseRevision().body,
  /** 新しい節の `/Prev` がその節自身を指す。 */
  cyclic: () => withUpdate((xrefAt) => String(xrefAt)),
  /** `/Prev` はあるが直接の正の整数ではない（§7.5.5 Table 15）。 */
  malformed: () => withUpdate('/notaninteger'),
  /** `xref` キーワードを潰す。節は読めないが本文の `N G obj` は無事。 */
  unreadableTable: () => {
    const one = baseRevision();
    const broken = one.body.replace(/\nxref\n/, '\nxrEf\n');
    if (broken === one.body) throw new Error('xref キーワードが見つからない');
    return broken;
  },
};

/** latin1 の本文を、そのままバイト列にする（1 文字 = 1 バイト）。 */
export const toBytes = (text) => new Uint8Array(Buffer.from(text, 'latin1'));
