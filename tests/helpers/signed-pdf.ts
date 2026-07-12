/**
 * Test fixture helpers: generate a self-signed certificate and
 * minimal signed PDFs entirely in memory (pkijs + WebCrypto).
 *
 * The PDF is hand-built from a template so that ByteRange offsets are
 * fully controlled, mimicking what signing libraries like node-signpdf do.
 */

import { webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { OID } from '../../src/constants.js';
import { ensureCryptoEngine } from '../../src/services/cms-verifier.js';

const PLACEHOLDER_HEX_LEN = 16384;

export interface TestIdentity {
  privateKey: CryptoKey;
  certificate: pkijs.Certificate;
}

/** Generate an RSA-2048 key pair and a self-signed certificate */
export async function createTestIdentity(
  commonName = 'pdf-verify-mcp test',
): Promise<TestIdentity> {
  ensureCryptoEngine();
  const algorithm = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048,
  };
  const keys = (await webcrypto.subtle.generateKey(algorithm, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ value: Date.now() % 1_000_000 });
  const cn = new pkijs.AttributeTypeAndValue({
    type: '2.5.4.3',
    value: new asn1js.PrintableString({ value: commonName }),
  });
  certificate.issuer.typesAndValues.push(cn);
  certificate.subject.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.PrintableString({ value: commonName }),
    }),
  );
  certificate.notBefore.value = new Date(Date.now() - 24 * 3600 * 1000);
  certificate.notAfter.value = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
  await certificate.sign(keys.privateKey, 'SHA-256');

  return { privateKey: keys.privateKey, certificate };
}

export interface BuildPdfOptions {
  subFilter?: 'ETSI.CAdES.detached' | 'adbe.pkcs7.detached';
  /** Add a DocMDP certification with this permission (1-3) */
  docMdpPermission?: number;
  /** Embed an XMP metadata stream with these declarations */
  xmp?: { pdfaPart?: string; pdfaConformance?: string; pdfuaPart?: string };
}

interface PdfTemplate {
  bytes: Uint8Array;
  contentsStart: number; // offset of '<'
  contentsEnd: number; // offset just after '>'
  byteRangeOffset: number; // offset of the ByteRange array placeholder
}

function buildXmpPacket(xmp: NonNullable<BuildPdfOptions['xmp']>): string {
  const pdfa =
    xmp.pdfaPart !== undefined
      ? `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="${xmp.pdfaPart}"${xmp.pdfaConformance ? ` pdfaid:conformance="${xmp.pdfaConformance}"` : ''}/>`
      : '';
  const pdfua =
    xmp.pdfuaPart !== undefined
      ? `<rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" pdfuaid:part="${xmp.pdfuaPart}"/>`
      : '';
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
${pdfa}
${pdfua}
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** Build a minimal single-page PDF with an (unsigned) signature placeholder */
function buildTemplate(options: BuildPdfOptions): PdfTemplate {
  const subFilter = options.subFilter ?? 'ETSI.CAdES.detached';
  const contentsPlaceholder = `<${'0'.repeat(PLACEHOLDER_HEX_LEN)}>`;
  const byteRangePlaceholder = '[0 0000000000 0000000000 0000000000]';

  const xmpPacket = options.xmp ? buildXmpPacket(options.xmp) : null;
  const xmpBytes = xmpPacket ? Buffer.byteLength(xmpPacket, 'utf8') : 0;

  const perms = options.docMdpPermission !== undefined ? ' /Perms << /DocMDP 5 0 R >>' : '';
  const metadata = xmpPacket ? ' /Metadata 7 0 R' : '';
  const reference =
    options.docMdpPermission !== undefined
      ? ` /Reference [<< /Type /SigRef /TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P ${options.docMdpPermission} /V /1.2 >> >>]`
      : '';

  const streamContent = 'BT 72 720 Td (Hello pdf-verify) Tj ET';
  const objects: string[] = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /SigFlags 3 >>${perms}${metadata} >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R] /Contents 6 0 R >>\nendobj\n`,
    `4 0 obj\n<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /F 132 /P 3 0 R /V 5 0 R >>\nendobj\n`,
    `5 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /${subFilter} /ByteRange ${byteRangePlaceholder} /Contents ${contentsPlaceholder} /M (D:20260712120000+09'00') /Reason (Unit test) /Location (Fixture)${reference} >>\nendobj\n`,
    `6 0 obj\n<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
  ];
  if (xmpPacket) {
    objects.push(
      `7 0 obj\n<< /Type /Metadata /Subtype /XML /Length ${xmpBytes} >>\nstream\n${xmpPacket}\nendstream\nendobj\n`,
    );
  }

  const header = '%PDF-1.7\n%âãÏÓ\n';
  let body = header;
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += obj;
  }
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  const size = objects.length + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const full = body + xref + trailer;

  const contentsStart = full.indexOf(contentsPlaceholder);
  const byteRangeOffset = full.indexOf(byteRangePlaceholder);
  if (contentsStart === -1 || byteRangeOffset === -1) {
    throw new Error('placeholder not found in template');
  }

  return {
    bytes: new Uint8Array(Buffer.from(full, 'latin1')),
    contentsStart,
    contentsEnd: contentsStart + contentsPlaceholder.length,
    byteRangeOffset,
  };
}

/** Create a detached CMS signature over the given data */
export async function createCmsSignature(
  identity: TestIdentity,
  data: Uint8Array,
): Promise<Uint8Array> {
  ensureCryptoEngine();
  const digest = await webcrypto.subtle.digest(
    'SHA-256',
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  );

  const signedData = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.DATA }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: identity.certificate.issuer,
          serialNumber: identity.certificate.serialNumber,
        }),
      }),
    ],
    certificates: [identity.certificate],
  });

  signedData.signerInfos[0].signedAttrs = new pkijs.SignedAndUnsignedAttributes({
    type: 0,
    attributes: [
      new pkijs.Attribute({
        type: OID.CONTENT_TYPE,
        values: [new asn1js.ObjectIdentifier({ value: OID.DATA })],
      }),
      new pkijs.Attribute({
        type: OID.SIGNING_TIME,
        values: [new asn1js.UTCTime({ valueDate: new Date() })],
      }),
      new pkijs.Attribute({
        type: OID.MESSAGE_DIGEST,
        values: [new asn1js.OctetString({ valueHex: digest })],
      }),
    ],
  });

  await signedData.sign(identity.privateKey, 0, 'SHA-256');

  const contentInfo = new pkijs.ContentInfo({
    contentType: OID.SIGNED_DATA,
    content: signedData.toSchema(true),
  });
  return new Uint8Array(contentInfo.toSchema().toBER(false));
}

/** Build and sign a minimal PDF; returns the final bytes */
export async function createSignedPdf(
  identity: TestIdentity,
  options: BuildPdfOptions = {},
): Promise<Uint8Array> {
  const template = buildTemplate(options);
  const { bytes, contentsStart, contentsEnd, byteRangeOffset } = template;

  const byteRange = [0, contentsStart, contentsEnd, bytes.length - contentsEnd];
  const byteRangeText = `[0 ${String(byteRange[1]).padStart(10, '0')} ${String(byteRange[2]).padStart(10, '0')} ${String(byteRange[3]).padStart(10, '0')}]`;
  bytes.set(Buffer.from(byteRangeText, 'latin1'), byteRangeOffset);

  const signedBytes = new Uint8Array(byteRange[1] + byteRange[3]);
  signedBytes.set(bytes.subarray(0, contentsStart), 0);
  signedBytes.set(bytes.subarray(contentsEnd), contentsStart);

  const cms = await createCmsSignature(identity, signedBytes);
  if (cms.length * 2 > PLACEHOLDER_HEX_LEN) {
    throw new Error('CMS payload exceeds placeholder size');
  }
  const hex = Buffer.from(cms).toString('hex').padEnd(PLACEHOLDER_HEX_LEN, '0');
  bytes.set(Buffer.from(hex, 'latin1'), contentsStart + 1);

  return bytes;
}

/** Flip a byte inside the signed content to simulate tampering */
export function tamperSignedPdf(signedPdf: Uint8Array): Uint8Array {
  const copy = signedPdf.slice();
  const marker = Buffer.from('Hello pdf-verify', 'latin1');
  const text = Buffer.from(copy);
  const index = text.indexOf(marker);
  if (index === -1) throw new Error('tamper marker not found');
  copy[index] = 'X'.charCodeAt(0);
  return copy;
}

/** Append an extra (empty) incremental revision after the signature */
export function appendIncrementalUpdate(signedPdf: Uint8Array): Uint8Array {
  const extra = Buffer.from(
    '\n% incremental update\nxref\n0 0\ntrailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
    'latin1',
  );
  const result = new Uint8Array(signedPdf.length + extra.length);
  result.set(signedPdf, 0);
  result.set(extra, signedPdf.length);
  return result;
}
