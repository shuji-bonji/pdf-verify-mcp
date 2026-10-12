/**
 * #23: PDF/A and XMP extension schemas — naming the namespace behind a veraPDF 6.6.2.3.1
 * failure, and reporting the packet's namespaces from identify_conformance.
 *
 * The veraPDF reports under tests/fixtures/verapdf/ are real output of veraPDF 1.28.2
 * (2026-10-12) on two PDF/A-3B specimens that declare TDMRep: one without an extension
 * schema (6.6.2.3.1 test1 and test2 fail on tdm:reservation and tdm:policy), one with a
 * pdfaExtension:schemas description of http://www.w3.org/ns/tdmrep/ (no XMP failure). CI has
 * no veraPDF, so the parsing is tested on the saved reports.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { identifyConformance } from '../../src/services/conformance.js';
import { parsePdfBytes } from '../../src/services/pdf-parser.js';
import { parseVeraPdfReport } from '../../src/services/verapdf.js';
import {
  analyzeXmpNamespaces,
  collectExtensionSchemaUris,
  explainXmpSchemaViolation,
  isXmpSchemaClause,
  parseVeraPdfXmpPropertyContext,
} from '../../src/services/xmp-schemas.js';
import { createSignedPdf, createTestIdentity, type TestIdentity } from '../helpers/signed-pdf.js';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'verapdf');
const report = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

const TDM_DESCRIPTION = `<rdf:Description rdf:about="" xmlns:tdm="http://www.w3.org/ns/tdmrep/">
  <tdm:reservation>1</tdm:reservation><tdm:policy>https://example.org/tdm</tdm:policy></rdf:Description>`;

const TDM_EXTENSION_SCHEMA = `<rdf:Description rdf:about=""
  xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
  xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
  xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
  <pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">
    <pdfaSchema:schema>TDM Reservation Protocol Schema</pdfaSchema:schema>
    <pdfaSchema:namespaceURI>http://www.w3.org/ns/tdmrep/</pdfaSchema:namespaceURI>
    <pdfaSchema:prefix>tdm</pdfaSchema:prefix>
    <pdfaSchema:property><rdf:Seq>
      <rdf:li rdf:parseType="Resource"><pdfaProperty:name>reservation</pdfaProperty:name><pdfaProperty:valueType>Integer</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>TDM rights reserved</pdfaProperty:description></rdf:li>
      <rdf:li rdf:parseType="Resource"><pdfaProperty:name>policy</pdfaProperty:name><pdfaProperty:valueType>URL</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>Policy URL</pdfaProperty:description></rdf:li>
    </rdf:Seq></pdfaSchema:property>
  </rdf:li></rdf:Bag></pdfaExtension:schemas></rdf:Description>`;

describe('veraPDF report parsing (#23)', () => {
  it('XS-1: the 6.6.2.3.1 failures carry the namespace and property veraPDF named', () => {
    const r = parseVeraPdfReport(report('tdm-noext-3b.json'), '3b');
    expect(r.compliant).toBe(false);
    const schema = r.violations.filter((v) => v.clause === '6.6.2.3.1');
    expect(schema).toHaveLength(2); // test1 and test2
    for (const v of schema) {
      expect(v.xmpProperties).toEqual([
        { namespace: 'http://www.w3.org/ns/tdmrep/', property: 'tdm:reservation' },
        { namespace: 'http://www.w3.org/ns/tdmrep/', property: 'tdm:policy' },
      ]);
    }
    // Other failed rules carry no xmpProperties — the field is specific to the schema clauses.
    const other = r.violations.find((v) => v.clause === '6.1.3');
    expect(other?.xmpProperties).toBeUndefined();
  });

  it('XS-2: with an extension schema in the packet, veraPDF raised no 6.6.2.3.* failure', () => {
    const r = parseVeraPdfReport(report('tdm-ext-3b.json'), '3b');
    expect(r.violations.some((v) => v.clause.startsWith('6.6.2.3'))).toBe(false);
  });

  it('XS-3: context parsing and the clause filter', () => {
    expect(
      parseVeraPdfXmpPropertyContext(
        'root/document[0]/metadata[0](19 0 obj PDMetadata)/XMPPackage[0]/Properties[4](http://www.w3.org/ns/tdmrep/ - tdm:reservation)',
      ),
    ).toEqual({ namespace: 'http://www.w3.org/ns/tdmrep/', property: 'tdm:reservation' });
    expect(parseVeraPdfXmpPropertyContext('root/document[0]/AA[0]/Actions[0]')).toBeNull();
    expect(isXmpSchemaClause('6.6.2.3.1')).toBe(true);
    expect(isXmpSchemaClause('6.7.8')).toBe(true); // PDF/A-1
    expect(isXmpSchemaClause('6.6.2.1')).toBe(false);
    expect(isXmpSchemaClause('6.1.3')).toBe(false);
  });

  it('XS-4: the explanation names TDMRep and says how PDF/A and TDMRep coexist', () => {
    const text = explainXmpSchemaViolation([
      { namespace: 'http://www.w3.org/ns/tdmrep/', property: 'tdm:reservation' },
      { namespace: 'http://www.w3.org/ns/tdmrep/', property: 'tdm:policy' },
      { namespace: 'http://example.com/private/', property: 'ex:thing' },
    ]);
    expect(text).toContain('http://www.w3.org/ns/tdmrep/ (tdm:reservation, tdm:policy)');
    expect(text).toContain('W3C TDM Reservation Protocol (TDMRep)');
    expect(text).toContain('pdfaExtension:schemas');
    expect(text).toContain('http://example.com/private/ (ex:thing) — not predefined');
    expect(explainXmpSchemaViolation([])).toBeNull();
  });
});

describe('XMP namespace analysis (#23)', () => {
  it('XS-5: classifies predefined / described / neither, and knows TDMRep under both spellings', () => {
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
        xmlns:tdm="http://www.w3.org/ns/tdmrep#" xmlns:ex="http://example.com/private/"/>${TDM_EXTENSION_SCHEMA}</rdf:RDF></x:xmpmeta>`;
    const ns = analyzeXmpNamespaces(xmp);
    const by = Object.fromEntries(ns.map((n) => [n.prefix, n]));
    expect(by.dc).toMatchObject({
      predefined: true,
      describedByExtensionSchema: false,
      known: null,
    });
    expect(by.pdfaid).toMatchObject({ predefined: true });
    expect(by.pdfaExtension).toMatchObject({ predefined: true });
    // the packet uses the `#` spelling but describes the `/` spelling — so this one is NOT described
    expect(by.tdm).toMatchObject({
      predefined: false,
      describedByExtensionSchema: false,
      known: 'W3C TDM Reservation Protocol (TDMRep)',
    });
    expect(by.ex).toMatchObject({
      predefined: false,
      describedByExtensionSchema: false,
      known: null,
    });
    expect(collectExtensionSchemaUris(xmp)).toEqual(['http://www.w3.org/ns/tdmrep/']);
  });
});

describe('identify_conformance reports the namespaces (#23)', () => {
  let identity: TestIdentity;
  beforeAll(async () => {
    identity = await createTestIdentity();
  });

  it('XS-6: PDF/A + TDMRep without an extension schema → note names the undescribed namespace', async () => {
    const pdf = await createSignedPdf(identity, {
      xmp: { pdfaPart: '3', pdfaConformance: 'B', extraRdf: TDM_DESCRIPTION },
    });
    const r = identifyConformance(await parsePdfBytes(pdf));
    expect(r.pdfA).toEqual({ part: '3', conformance: 'B' });
    const tdm = r.xmpNamespaces.find((n) => n.prefix === 'tdm');
    expect(tdm).toMatchObject({
      uri: 'http://www.w3.org/ns/tdmrep/',
      predefined: false,
      describedByExtensionSchema: false,
      known: 'W3C TDM Reservation Protocol (TDMRep)',
    });
    const note = r.notes.find((n) => n.includes('does not predefine'));
    expect(note).toContain('http://www.w3.org/ns/tdmrep/ (W3C TDM Reservation Protocol (TDMRep))');
    expect(note).toContain('ISO 19005-2 6.6.2.3');
    expect(note).toContain('not a validation result');
  });

  it('XS-7: with the extension schema the namespace is described and no such note appears', async () => {
    const pdf = await createSignedPdf(identity, {
      xmp: {
        pdfaPart: '3',
        pdfaConformance: 'B',
        extraRdf: TDM_DESCRIPTION + TDM_EXTENSION_SCHEMA,
      },
    });
    const r = identifyConformance(await parsePdfBytes(pdf));
    expect(r.xmpNamespaces.find((n) => n.prefix === 'tdm')?.describedByExtensionSchema).toBe(true);
    expect(r.notes.some((n) => n.includes('does not predefine'))).toBe(false);
  });

  it('XS-8: TDMRep without a PDF/A declaration is reported, not warned about', async () => {
    const pdf = await createSignedPdf(identity, { xmp: { extraRdf: TDM_DESCRIPTION } });
    const r = identifyConformance(await parsePdfBytes(pdf));
    expect(r.pdfA).toBeNull();
    expect(r.xmpNamespaces.find((n) => n.prefix === 'tdm')?.known).toBe(
      'W3C TDM Reservation Protocol (TDMRep)',
    );
    expect(r.notes.some((n) => n.includes('does not predefine'))).toBe(false);
  });
});

describe('evaluate_policy advisory names the namespace (#23)', () => {
  it('XS-9: a PDF/A failure caused by an undescribed TDMRep schema is named in the advisories', async () => {
    const { evaluatePolicy } = await import('../../src/services/policy-engine.js');
    const { parseVeraPdfReport: parse } = await import('../../src/services/verapdf.js');
    const vera = parse(report('tdm-noext-3b.json'), '3b');
    // Shape the veraPDF violations the way validateConformance does (clause + detail).
    const conformance = {
      engine: 'verapdf',
      flavour: 'PDF/A-3b',
      compliant: false,
      checkedRules: 3,
      passedRules: 0,
      failedRules: 3,
      violations: vera.violations.map((v) => ({
        ruleId: v.ruleId,
        clause: v.clause,
        description: v.description,
        detail: v.xmpProperties ? explainXmpSchemaViolation(v.xmpProperties) : null,
      })),
      violationsTruncated: null,
      notes: [],
      authoritativeValidation: {
        performed: true,
        validator: 'verapdf',
        path: '/x',
        version: '1.28.2',
      },
    } as unknown as import('../../src/services/conformance-validation.js').ConformanceValidationReport;
    const e = evaluatePolicy(
      {
        signatures: [],
        integrity: {
          revisionCount: 1,
          incrementalUpdateCount: 0,
          lastSignatureCoversFile: null,
          signaturesWithLaterChanges: [],
          certification: null,
          hasDss: false,
        } as unknown as import('../../src/types.js').IntegrityReport,
        pades: [],
        conformance,
      },
      'financial',
    );
    const named = e.advisories.filter((a) => a.startsWith('6.6.2.3.1:'));
    expect(named.length).toBeGreaterThan(0);
    expect(named[0]).toContain('W3C TDM Reservation Protocol (TDMRep)');
    expect(named[0]).toContain('pdfaExtension:schemas');
    // The verdict itself is unchanged by this: PDF/A violations were already an advisory.
    expect(e.firedRules.map((r) => r.ruleId)).not.toContain('POL-REJECT-INVALID');
  });
});
