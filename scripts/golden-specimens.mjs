#!/usr/bin/env node
/**
 * L0 の検体を作る（B2 = pdf-verify-mcp の pdf-lib 撤去）。
 *
 * veraPDF コーパスと fixtures には無い軸を、ここで足す:
 *   暗号化 4 方式（RC4 V1R2 / RC4 V2R3 / AESV2 / AESV3）× 空のユーザパスワード・パスワードあり
 *   暗号化オブジェクトストリームの中の構造木（L4 の可否を決める軸）
 *   アクセシビリティ許可を落とした暗号化（skippedRules の軸）
 *   ヘッダが 0 バイト目に無い文書（origin > 0）
 *
 * 出力は `.golden/specimens/` と、そこを読むための `manifest.json`
 * （パスワードと軸を持つ。ゴールデンの take はこれを読んで引数を決める）。
 *
 * 🔴 **一度作ったら作り直さない。** 撤去前後で同じバイト列を読ませるための集合であり、
 * pdf-lib の `PDFDocument.create()` は保存のたびに ModDate を書くので再生成すると別物になる。
 *
 * 使い方: node scripts/golden-specimens.mjs [--force]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, '.golden/specimens');
const FORCE = process.argv.includes('--force');

if (existsSync(join(OUT, 'manifest.json')) && !FORCE) {
  console.error('manifest.json がある。作り直すと撤去前のバイト列が変わる。--force が要る。');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

/** tests/helpers/ua-pdf.ts の buildUaPdf を .mjs に写したもの（型だけ落とした）。 */
function xmpPacket(part, title) {
  const ua = part
    ? `<rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" pdfuaid:part="${part}"/>`
    : '';
  const dc = title
    ? `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title></rdf:Description>`
    : '';
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
${ua}
${dc}
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

async function buildUaPdf(options = {}) {
  const {
    marked = true,
    structTree = true,
    lang = 'ja-JP',
    displayDocTitle = true,
    title = 'Accessible Document',
    omitXmpTitle = false,
    pdfuaPart = '1',
    elements = [{ tag: 'H1' }, { tag: 'P' }],
    link,
  } = options;

  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const { context, catalog } = doc;

  if (title) doc.setTitle(title);
  if (marked) catalog.set(PDFName.of('MarkInfo'), context.obj({ Marked: true }));
  if (lang) catalog.set(PDFName.of('Lang'), PDFString.of(lang));
  catalog.set(PDFName.of('ViewerPreferences'), context.obj({ DisplayDocTitle: displayDocTitle }));

  if (structTree) {
    const rootRef = context.nextRef();
    const kids = context.obj([]);
    for (const el of elements) {
      const dict = context.obj({});
      dict.set(PDFName.of('Type'), PDFName.of('StructElem'));
      dict.set(PDFName.of('S'), PDFName.of(el.tag));
      dict.set(PDFName.of('P'), rootRef);
      dict.set(PDFName.of('Pg'), page.ref);
      if (el.alt !== undefined) dict.set(PDFName.of('Alt'), PDFHexString.fromText(el.alt));
      kids.push(context.register(dict));
    }
    const rootDict = context.obj({});
    rootDict.set(PDFName.of('Type'), PDFName.of('StructTreeRoot'));
    rootDict.set(PDFName.of('K'), kids);
    context.assign(rootRef, rootDict);
    catalog.set(PDFName.of('StructTreeRoot'), rootRef);
  }

  if (link) {
    const annot = context.obj({});
    annot.set(PDFName.of('Type'), PDFName.of('Annot'));
    annot.set(PDFName.of('Subtype'), PDFName.of('Link'));
    annot.set(PDFName.of('Rect'), context.obj([10, 10, 100, 30]));
    if (link.contents !== undefined) {
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(link.contents));
    }
    page.node.set(PDFName.of('Annots'), context.obj([context.register(annot)]));
  }

  const xmpStream = context.stream(xmpPacket(pdfuaPart, omitXmpTitle ? null : title), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  catalog.set(PDFName.of('Metadata'), context.register(xmpStream));

  return doc.save();
}

const qpdf = (args) => execFileSync('qpdf', args, { cwd: OUT, stdio: ['ignore', 'pipe', 'pipe'] });

const entries = [];
const add = (name, axes, password) => {
  const bytes = readFileSync(join(OUT, name));
  entries.push({
    name,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    axes,
    ...(password === undefined ? {} : { password }),
  });
};

// 素の PDF/UA 文書。以下の暗号化検体は全部これを元にする（構造木が中に居る）
writeFileSync(join(OUT, 'ua-plain.pdf'), await buildUaPdf());
add('ua-plain.pdf', ['tagged', 'pdfua-declared', 'object-streams', 'xref-stream']);

// 暗号化 4 方式。qpdf の 40=V1R2 / 128=V2R3 / 128+aes=V4R4(AESV2) / 256=V5R6(AESV3)
const enc = [
  ['ua-enc-rc4-40.pdf', ['--encrypt', '', 'owner', '40', '--'], ['encrypted', 'rc4-v1r2', 'object-streams'], ''],
  ['ua-enc-rc4-128.pdf', ['--encrypt', '', 'owner', '128', '--'], ['encrypted', 'rc4-v2r3', 'object-streams'], ''],
  ['ua-enc-aesv2.pdf', ['--encrypt', '', 'owner', '128', '--use-aes=y', '--'], ['encrypted', 'aesv2', 'object-streams'], ''],
  ['ua-enc-aesv2-pw.pdf', ['--encrypt', 'secret', 'owner', '128', '--use-aes=y', '--'], ['encrypted', 'aesv2', 'object-streams', 'user-password'], 'secret'],
  ['ua-enc-aesv3.pdf', ['--encrypt', '', 'owner', '256', '--'], ['encrypted', 'aesv3', 'object-streams'], ''],
  ['ua-enc-aesv3-pw.pdf', ['--encrypt', 'secret', 'owner', '256', '--'], ['encrypted', 'aesv3', 'object-streams', 'user-password'], 'secret'],
  ['ua-enc-aesv3-noaccess.pdf', ['--encrypt', '', 'owner', '256', '--accessibility=n', '--'], ['encrypted', 'aesv3', 'object-streams', 'accessibility-denied'], ''],
];
for (const [name, flags, axes, password] of enc) {
  qpdf([...flags, 'ua-plain.pdf', name]);
  add(name, axes, password);
}

// pdf-lib の save() は既定でオブジェクトストリームを使うので、上の暗号化検体は
// すべて「暗号化オブジェクトストリーム」を含む（L4 の軸はここで満たされている）。
// 対照として、オブジェクトストリームを持たない版を作る。これが無いと、差が出たときに
// 「暗号化のせい」か「暗号化オブジェクトストリームのせい」かを分けられない
qpdf(['--object-streams=disable', '--', 'ua-plain.pdf', 'ua-flat.pdf']);
add('ua-flat.pdf', ['xref-table', 'no-object-streams']);

qpdf(['--object-streams=disable', '--encrypt', '', 'owner', '256', '--', 'ua-plain.pdf', 'ua-enc-aesv3-flat.pdf']);
add('ua-enc-aesv3-flat.pdf', ['encrypted', 'aesv3', 'no-object-streams'], '');

// ヘッダが 0 バイト目に無い文書（origin > 0）
const plain = readFileSync(join(OUT, 'ua-plain.pdf'));
writeFileSync(join(OUT, 'ua-origin-offset.pdf'), Buffer.concat([Buffer.from('%junk before the header\n'), plain]));
add('ua-origin-offset.pdf', ['origin-gt-0']);

// startxref が壊れた文書（§7.5.4。normativepdf は条文どおり読み、回復は消費者側）
const broken = Buffer.from(plain);
const at = broken.lastIndexOf(Buffer.from('startxref'));
const nl = broken.indexOf(0x0a, at + 10);
const digits = broken.subarray(at + 10, nl);
Buffer.from('9'.repeat(digits.length)).copy(broken, at + 10);
writeFileSync(join(OUT, 'ua-broken-startxref.pdf'), broken);
add('ua-broken-startxref.pdf', ['broken-xref']);

const manifest = {
  builtAt: new Date().toISOString(),
  qpdfVersion: String(execFileSync('qpdf', ['--version'])).split('\n')[0],
  note: '一度作ったら作り直さない。撤去前後で同じバイト列を読ませるための集合。',
  specimens: entries.sort((a, b) => a.name.localeCompare(b.name)),
};
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${entries.length} 検体を ${OUT} に書いた`);
for (const e of manifest.specimens) console.log(`  ${e.name}  ${e.bytes}B  [${e.axes.join(' ')}]`);
