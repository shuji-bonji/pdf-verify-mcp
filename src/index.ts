#!/usr/bin/env node
/**
 * pdf-verify-mcp - MCP server for PDF authenticity verification.
 *
 * Cryptographic signature verification, tamper detection, PAdES level
 * detection, and conformance declaration identification.
 * Complements pdf-reader-mcp (structure) and pdf-spec-mcp (specification).
 */

// IMPORTANT: Install the stdout guard before ANY other import.
// ESM hoists imports, so the guard lives in a side-effect module that must
// be listed first to run before dependency modules are evaluated.
import './utils/stdout-guard.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PACKAGE_INFO, SERVER_NAME } from './config.js';
import { registerAllTools } from './tools/index.js';

/**
 * `initialize` の応答としてクライアントへ返す説明（family 規約: PDFfamily specs/06 §2.10）。
 *
 * **本サーバは「適合を証明する」と読まれやすい。** 実際にできるのは反証だけであり、
 * さらに規範を手元に持っているかで言える強さが 3 層に分かれる（specs/09 §2）。
 * ツール説明にも書いてあるが、`instructions` はツールを 1 つも呼ばないうちに読まれる。
 * 先例は pdf-spec-mcp v0.4.5（Issue #13）/ reader v0.9.2 / writer v0.15.1。
 */
const INSTRUCTIONS = `This server DISPROVES. It cannot prove that a document conforms or that a signature is trustworthy.

Read every result as "what could be shown to be wrong, was looked for" — not as a certificate.

How strongly a result can be stated depends on whether the normative text is at hand:

  T1 — ISO 32000-1/-2, ISO 14289 (PDF/UA): the clause can be quoted. State it plainly.
  T2 — ISO 19005 (PDF/A): the standard is NOT in this family's corpus. veraPDF decides.
       Say "veraPDF judged this COMPLIANT", never "conforms to ISO 19005".
  T3 — ETSI EN 319 142 (PAdES B-B / B-T / B-LT / B-LTA): no normative text, and no third-party
       validator either. detect_pades_level OBSERVES structure (timestamp, DSS, coverage of the
       signer) and reports which level that structure matches. That is an observation, not a
       conformance verdict — do not write "conforms to PAdES B-LT".

Two more limits that get forgotten:
  - Trust. A "valid" verdict without trust_anchors means the cryptography checks out, NOT that
    the signer is who they claim. trust: not_evaluated is reported for exactly this reason.
  - Revocation. If it could not be checked, "not revoked" cannot be claimed either.

evaluate_policy returns a deterministic verdict (trust_and_use / use_with_caution /
human_review_required / reject) from a rule engine over the facts — same facts and profile give
the same verdict. Its advisories never change that verdict; do not treat an advisory as a
failure, or its absence as a pass.

Nothing here judges whether the content is true. A validly signed document can state falsehoods.

For what a specification requires, ask pdf-spec-mcp. For what is inside a file, ask
pdf-reader-mcp.`;

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: PACKAGE_INFO.version,
  },
  { instructions: INSTRUCTIONS },
);

registerAllTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${PACKAGE_INFO.version} running via stdio`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
