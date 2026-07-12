/**
 * Test fixture helpers: generate certificates (self-signed or CA-chained),
 * CRLs, RFC 3161 timestamp tokens, and minimal signed PDFs entirely
 * in memory (pkijs + WebCrypto).
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
const TSTINFO_OID = '1.2.840.113549.1.9.16.1.4';

export interface TestIdentity {
  privateKey: CryptoKey;
  certificate: pkijs.Certificate;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  ensureCryptoEngine();
  return (await webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
      publicExponent: new Uint8Array([1, 0, 1]),
      modulusLength: 2048,
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

function cnAttribute(commonName: string): pkijs.AttributeTypeAndValue {
  return new pkijs.AttributeTypeAndValue({
    type: '2.5.4.3',
    value: new asn1js.PrintableString({ value: commonName }),
  });
}

function keyUsageExtension(bits: number): pkijs.Extension {
  const buffer = new ArrayBuffer(1);
  new Uint8Array(buffer)[0] = bits;
  return new pkijs.Extension({
    extnID: '2.5.29.15',
    critical: true,
    extnValue: new asn1js.BitString({ valueHex: buffer }).toBER(false),
  });
}

interface CertificateOptions {
  commonName: string;
  isCa?: boolean;
  issuer?: TestIdentity;
  serial?: number;
  /** Add an AIA extension pointing to this OCSP URL */
  ocspUrl?: string;
  /** Add an AIA caIssuers entry pointing to this URL */
  caIssuersUrl?: string;
  /** Add a CRLDistributionPoints extension pointing to this URL */
  crlUrl?: string;
}

/** Create a certificate (self-signed when no issuer is given) */
export async function createIdentity(options: CertificateOptions): Promise<TestIdentity> {
  ensureCryptoEngine();
  const keys = await generateRsaKeyPair();

  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({
    value: options.serial ?? Math.floor(Math.random() * 1_000_000) + 1,
  });
  const issuerSubject = options.issuer
    ? options.issuer.certificate.subject.typesAndValues
    : [cnAttribute(options.commonName)];
  certificate.issuer.typesAndValues.push(...issuerSubject);
  certificate.subject.typesAndValues.push(cnAttribute(options.commonName));
  certificate.notBefore.value = new Date(Date.now() - 24 * 3600 * 1000);
  certificate.notAfter.value = new Date(Date.now() + 365 * 24 * 3600 * 1000);

  certificate.extensions = [];
  if (options.isCa) {
    certificate.extensions.push(
      new pkijs.Extension({
        extnID: '2.5.29.19',
        critical: true,
        extnValue: new pkijs.BasicConstraints({ cA: true }).toSchema().toBER(false),
      }),
      keyUsageExtension(0x06), // keyCertSign | cRLSign
    );
  } else {
    certificate.extensions.push(keyUsageExtension(0x80)); // digitalSignature
  }
  if (options.ocspUrl || options.caIssuersUrl) {
    const accessDescriptions: pkijs.AccessDescription[] = [];
    if (options.ocspUrl) {
      accessDescriptions.push(
        new pkijs.AccessDescription({
          accessMethod: '1.3.6.1.5.5.7.48.1',
          accessLocation: new pkijs.GeneralName({ type: 6, value: options.ocspUrl }),
        }),
      );
    }
    if (options.caIssuersUrl) {
      accessDescriptions.push(
        new pkijs.AccessDescription({
          accessMethod: '1.3.6.1.5.5.7.48.2',
          accessLocation: new pkijs.GeneralName({ type: 6, value: options.caIssuersUrl }),
        }),
      );
    }
    const infoAccess = new pkijs.InfoAccess({ accessDescriptions });
    certificate.extensions.push(
      new pkijs.Extension({
        extnID: '1.3.6.1.5.5.7.1.1',
        critical: false,
        extnValue: infoAccess.toSchema().toBER(false),
      }),
    );
  }
  if (options.crlUrl) {
    const cdp = new pkijs.CRLDistributionPoints({
      distributionPoints: [
        new pkijs.DistributionPoint({
          distributionPoint: [new pkijs.GeneralName({ type: 6, value: options.crlUrl })],
        }),
      ],
    });
    certificate.extensions.push(
      new pkijs.Extension({
        extnID: '2.5.29.31',
        critical: false,
        extnValue: cdp.toSchema().toBER(false),
      }),
    );
  }

  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
  await certificate.sign(options.issuer?.privateKey ?? keys.privateKey, 'SHA-256');

  return { privateKey: keys.privateKey, certificate };
}

/** Generate an RSA-2048 key pair and a self-signed certificate */
export async function createTestIdentity(
  commonName = 'pdf-verify-mcp test',
): Promise<TestIdentity> {
  return createIdentity({ commonName });
}

/** Create a CA identity (BasicConstraints cA=true) */
export async function createTestCa(commonName = 'pdf-verify-mcp test CA'): Promise<TestIdentity> {
  return createIdentity({ commonName, isCa: true });
}

/** Create a CRL issued by the CA, revoking the given serial numbers */
export async function createCrl(
  ca: TestIdentity,
  revokedSerials: asn1js.Integer[] = [],
): Promise<Uint8Array> {
  ensureCryptoEngine();
  const crl = new pkijs.CertificateRevocationList();
  crl.version = 1;
  crl.issuer.typesAndValues.push(...ca.certificate.subject.typesAndValues);
  crl.thisUpdate = new pkijs.Time({ type: 0, value: new Date(Date.now() - 3600 * 1000) });
  crl.nextUpdate = new pkijs.Time({ type: 0, value: new Date(Date.now() + 30 * 24 * 3600 * 1000) });
  if (revokedSerials.length > 0) {
    crl.revokedCertificates = revokedSerials.map(
      (serial) =>
        new pkijs.RevokedCertificate({
          userCertificate: serial,
          revocationDate: new pkijs.Time({ type: 0, value: new Date() }),
        }),
    );
  }
  await crl.sign(ca.privateKey, 'SHA-256');
  return new Uint8Array(crl.toSchema(true).toBER(false));
}

/** Export a certificate as PEM text (for trust anchor files) */
export function certificateToPem(identity: TestIdentity): string {
  const der = Buffer.from(identity.certificate.toSchema(true).toBER(false));
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/** Create an RFC 3161 timestamp token over the given data */
export async function createTimestampToken(
  tsa: TestIdentity,
  data: Uint8Array,
): Promise<Uint8Array> {
  ensureCryptoEngine();
  const imprint = await webcrypto.subtle.digest('SHA-256', toArrayBuffer(data));

  const tstInfo = new pkijs.TSTInfo({
    version: 1,
    policy: '1.3.6.1.4.1.99999.1',
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.SHA256 }),
      hashedMessage: new asn1js.OctetString({ valueHex: imprint }),
    }),
    serialNumber: new asn1js.Integer({ value: Date.now() % 1_000_000 }),
    genTime: new Date(),
  });
  const tstDer = tstInfo.toSchema().toBER(false);

  const encapContentInfo = new pkijs.EncapsulatedContentInfo({ eContentType: TSTINFO_OID });
  // Assign directly to avoid pkijs's constructed (chunked) OCTET STRING
  // encoding — real-world TSAs emit a primitive OCTET STRING.
  encapContentInfo.eContent = new asn1js.OctetString({ valueHex: tstDer });

  const signedData = new pkijs.SignedData({
    version: 3,
    encapContentInfo,
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: tsa.certificate.issuer,
          serialNumber: tsa.certificate.serialNumber,
        }),
      }),
    ],
    certificates: [tsa.certificate],
  });

  const contentDigest = await webcrypto.subtle.digest('SHA-256', tstDer);
  signedData.signerInfos[0].signedAttrs = new pkijs.SignedAndUnsignedAttributes({
    type: 0,
    attributes: [
      new pkijs.Attribute({
        type: OID.CONTENT_TYPE,
        values: [new asn1js.ObjectIdentifier({ value: TSTINFO_OID })],
      }),
      new pkijs.Attribute({
        type: OID.MESSAGE_DIGEST,
        values: [new asn1js.OctetString({ valueHex: contentDigest })],
      }),
    ],
  });

  await signedData.sign(tsa.privateKey, 0, 'SHA-256');
  const contentInfo = new pkijs.ContentInfo({
    contentType: OID.SIGNED_DATA,
    content: signedData.toSchema(true),
  });
  return new Uint8Array(contentInfo.toSchema().toBER(false));
}

export interface BuildPdfOptions {
  subFilter?: 'ETSI.CAdES.detached' | 'adbe.pkcs7.detached';
  /** Add a DocMDP certification with this permission (1-3) */
  docMdpPermission?: number;
  /** Embed an XMP metadata stream with these declarations */
  xmp?: { pdfaPart?: string; pdfaConformance?: string; pdfuaPart?: string };
  /** Embed a DSS with these DER payloads */
  dss?: { certs?: Uint8Array[]; ocsps?: Uint8Array[]; crls?: Uint8Array[] };
  /** TSA identity: adds an RFC 3161 signature timestamp to the CMS */
  tsa?: TestIdentity;
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

/** Encode DER bytes as a latin1-safe PDF stream body */
function derToStreamObject(objNumber: number, der: Uint8Array): string {
  const body = Buffer.from(der).toString('latin1');
  return `${objNumber} 0 obj\n<< /Length ${der.length} >>\nstream\n${body}\nendstream\nendobj\n`;
}

/** Build a minimal single-page PDF with an (unsigned) signature placeholder */
function buildTemplate(options: BuildPdfOptions): PdfTemplate {
  const subFilter = options.subFilter ?? 'ETSI.CAdES.detached';
  const contentsPlaceholder = `<${'0'.repeat(PLACEHOLDER_HEX_LEN)}>`;
  const byteRangePlaceholder = '[0 0000000000 0000000000 0000000000]';

  // The whole template is serialized as latin1, so /Length must count
  // latin1 bytes too (utf8 counting made veraPDF flag a Length mismatch).
  const xmpPacket = options.xmp ? buildXmpPacket(options.xmp) : null;
  const xmpBytes = xmpPacket ? Buffer.byteLength(xmpPacket, 'latin1') : 0;

  const perms = options.docMdpPermission !== undefined ? ' /Perms << /DocMDP 5 0 R >>' : '';
  const reference =
    options.docMdpPermission !== undefined
      ? ` /Reference [<< /Type /SigRef /TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P ${options.docMdpPermission} /V /1.2 >> >>]`
      : '';

  // Objects 1-6 are fixed; extra objects (XMP, DSS streams) get numbers from 7 up.
  let nextObj = 7;
  const extraObjects: string[] = [];

  let metadata = '';
  if (xmpPacket) {
    metadata = ` /Metadata ${nextObj} 0 R`;
    extraObjects.push(
      `${nextObj} 0 obj\n<< /Type /Metadata /Subtype /XML /Length ${xmpBytes} >>\nstream\n${xmpPacket}\nendstream\nendobj\n`,
    );
    nextObj++;
  }

  let dssEntry = '';
  if (options.dss) {
    const parts: string[] = [];
    for (const [key, items] of [
      ['Certs', options.dss.certs ?? []],
      ['OCSPs', options.dss.ocsps ?? []],
      ['CRLs', options.dss.crls ?? []],
    ] as const) {
      if (items.length === 0) continue;
      const refs: string[] = [];
      for (const der of items) {
        refs.push(`${nextObj} 0 R`);
        extraObjects.push(derToStreamObject(nextObj, der));
        nextObj++;
      }
      parts.push(`/${key} [${refs.join(' ')}]`);
    }
    if (parts.length > 0) {
      dssEntry = ` /DSS << ${parts.join(' ')} >>`;
    }
  }

  const streamContent = 'BT 72 720 Td (Hello pdf-verify) Tj ET';
  const objects: string[] = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /SigFlags 3 >>${perms}${metadata}${dssEntry} >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R] /Contents 6 0 R >>\nendobj\n`,
    `4 0 obj\n<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /F 132 /P 3 0 R /V 5 0 R >>\nendobj\n`,
    `5 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /${subFilter} /ByteRange ${byteRangePlaceholder} /Contents ${contentsPlaceholder} /M (D:20260712120000+09'00') /Reason (Unit test) /Location (Fixture)${reference} >>\nendobj\n`,
    `6 0 obj\n<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
    ...extraObjects,
  ];

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
  tsa?: TestIdentity,
): Promise<Uint8Array> {
  ensureCryptoEngine();
  const digest = await webcrypto.subtle.digest('SHA-256', toArrayBuffer(data));

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

  // Attach an RFC 3161 signature timestamp (unsigned attribute) if requested.
  // The timestamp covers the signature value.
  if (tsa) {
    const signatureValue = new Uint8Array(
      signedData.signerInfos[0].signature.valueBlock.valueHexView,
    );
    const token = await createTimestampToken(tsa, signatureValue);
    const tokenAsn1 = asn1js.fromBER(toArrayBuffer(token));
    if (tokenAsn1.offset === -1) throw new Error('failed to re-parse timestamp token');
    signedData.signerInfos[0].unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 1,
      attributes: [
        new pkijs.Attribute({
          type: OID.SIGNATURE_TIME_STAMP,
          values: [tokenAsn1.result],
        }),
      ],
    });
  }

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

  const cms = await createCmsSignature(identity, signedBytes, options.tsa);
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
