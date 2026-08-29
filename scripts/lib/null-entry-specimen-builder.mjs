/**
 * 「値が `null` の辞書エントリ」を持つ検体の組み立て（ISO 32000-2 §7.3.7）。
 *
 *   "A dictionary entry whose value is null shall be treated the same as if
 *    the entry does not exist."
 *
 * **なぜ要るか**: コーパス 2,950 件を全部走査して、値が `null` のエントリを持つ
 * 検体は 0 件だった（`scripts/probe-null-entries.mjs`）。この軸が集合に無いので、
 * `@normativepdf/recover` 0.1.1 が `has()` を条文に合わせても A/B は 0 件になる。
 * 差 0 件は「変わらなかった」ではなく「その形が集合に無い」である。
 *
 * この検体は **2 つの向きを 1 ファイルで踏む**:
 *
 *   `/FontFile2 null`（FontDescriptor）—— 「在るべき鍵」。条文どおりに読むと
 *     「埋め込まれていない」になり、PDF/A のフォント埋め込み規則が **fail する**
 *   `/AA null`（目録）—— 「在ってはならない鍵」。条文どおりに読むと
 *     「AA は無い」になり、ISO 19005-1 6.6.2 が **pass する**
 *
 * 0.1.1 より前はどちらも逆だった。
 *
 * qpdf も pdf-lib も使わない —— 値が `null` のエントリはどちらも書き出さないか
 * 正規化してしまうので、バイト列をこちらで決める。副作用は持たない
 * （書き出すのは `scripts/golden-specimens-nullentry.mjs`、同じものをテストも読む）。
 */

/** 相互参照表の 1 行は正確に 20 バイト（§7.5.4）。 */
const xrefEntry = (offset, gen, type) =>
  `${String(offset).padStart(10, '0')} ${String(gen).padStart(5, '0')} ${type}\r\n`;

/** PDF/A-1b を名乗る XMP。`validate_conformance` はこの宣言を見て規則を選ぶ。 */
const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>1</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

/**
 * 🔴 オブジェクト番号は 1 から連番にする。相互参照表を `0 N` の 1 節で書くので、
 * 番号を飛ばすと表の並びと番号がずれ、`/Contents` が別のオブジェクトを指す
 * （一度そうなって、検体が「文字を出していない」ことになった）。
 */
function layout(header, objects) {
  let text = header;
  const offsets = new Map();
  for (const [num, body] of objects) {
    offsets.set(num, Buffer.byteLength(text, 'latin1'));
    text += `${num} 0 obj\n${body}\nendobj\n`;
  }
  return { text, offsets };
}

/**
 * 検体を 1 つ組む。`fontFile` と `aa` の**値だけ**が違い、ほかは同じ組み立て。
 *
 * 文字列置換ではなく、どちらも `layout` を通して組む —— 置換で長さが変わると
 * 相互参照表の offset がずれ、狙った軸ではなく「表が読めない」を測ることになる
 * （実際に一度そうなった）。
 */
function build({ fontFile, aa, fontProgram, renderMode }) {
  const xmpLength = Buffer.byteLength(XMP, 'latin1');
  const program = '\x00\x01\x00\x00 fake sfnt for the specimen';
  const objects = [
    [1, `<< /Type /Catalog /Pages 2 0 R /Metadata 6 0 R /AA ${aa} >>`],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 7 0 R ' +
        '/Resources << /Font << /F1 4 0 R >> >> >>',
    ],
    [4, '<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+NullTest /FontDescriptor 5 0 R >>'],
    [
      5,
      '<< /Type /FontDescriptor /FontName /AAAAAA+NullTest /Flags 4 ' +
        '/ItalicAngle 0 /StemV 80 /FontBBox [0 0 1000 1000] ' +
        `/Ascent 800 /Descent -200 /CapHeight 700 /FontFile2 ${fontFile} >>`,
    ],
    [6, `<< /Type /Metadata /Subtype /XML /Length ${xmpLength} >>\nstream\n${XMP}\nendstream`],
  ];
  // 🔴 実際に文字を出す。`fonts-embedded` は 0.25.0 から**使われたフォント**を見るので、
  // コンテンツが無いと「未使用」になり、この検体は何も測らなくなる（一度そうなった）。
  const content =
    `BT /F1 24 Tf ${renderMode === 3 ? '3 Tr ' : ''}20 100 Td (Hello) Tj ET\n`;
  const contentLength = Buffer.byteLength(content, 'latin1');
  objects.push([7, `<< /Length ${contentLength} >>\nstream\n${content}endstream`]);

  if (fontProgram) {
    const length = Buffer.byteLength(program, 'latin1');
    objects.push([
      8,
      `<< /Length ${length} /Length1 ${length} >>\nstream\n${program}\nendstream`,
    ]);
  }
  const { text, offsets } = layout('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', objects);
  const size = objects.length + 1;
  const xrefAt = Buffer.byteLength(text, 'latin1');
  let table = `${text}xref\n0 ${size}\n` + xrefEntry(0, 65535, 'f');
  for (const [num] of objects) table += xrefEntry(offsets.get(num), 0, 'n');
  return (
    `${table}trailer\n<< /Size ${size} /Root 1 0 R ` +
    '/ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>] >>\n' +
    `startxref\n${xrefAt}\n%%EOF\n`
  );
}

/**
 * 値が `null` のエントリを 2 か所に持つ、PDF/A-1b を名乗る 1 ページの文書。
 * ほかは条文どおりに組む —— 壊れた構造で判定が動くと、何が効いたか分からなくなる。
 */
export function nullValuedEntry() {
  return build({ fontFile: 'null', aa: 'null', fontProgram: false, renderMode: 0 });
}

/**
 * 値は `null` のまま、**文字を不可視（モード 3）で出す**もの。
 * PDF/A は不可視のテキストに使うフォントの埋め込みを求めないので、
 * `fonts-embedded` は pass になる —— `nullValuedEntry` と答えが分かれる。
 */
export function nullValuedInvisible() {
  return build({ fontFile: 'null', aa: 'null', fontProgram: false, renderMode: 3 });
}

/**
 * 空振り検査の対。**同じ組み立てで、値だけが入っている。**
 * `/FontFile2` は実在するストリームを指し、`/AA` は空の辞書を持つ。
 * こちらではフォント埋め込みの規則が pass し、`no-aa-catalog` が fail する
 * —— 値が `null` のほうと**答えが逆になる**ことを、同じ表で確かめる。
 */
export function valuedEntry() {
  return build({ fontFile: '8 0 R', aa: '<< >>', fontProgram: true, renderMode: 0 });
}

export const specimens = { nullValuedEntry, nullValuedInvisible, valuedEntry };
export const toBytes = (text) => new Uint8Array(Buffer.from(text, 'latin1'));
