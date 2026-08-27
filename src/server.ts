/**
 * MCP サーバの組み立て（family 規約 specs/06 §2.1: McpServer + registerTool + zod）。
 *
 * index.ts から切り離してある理由は、トランスポートを立てずにサーバを組めるようにするため。
 * `tests/unit/registry.test.ts` が InMemoryTransport 越しにここを駆動して、
 * 外部に出るツールの仕様（名前・引数・必須キー・additionalProperties）を固定する。
 * index.ts は stdio に繋ぐ入口だけを持つ。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
const INSTRUCTIONS = `${SERVER_NAME} v${PACKAGE_INFO.version} — the running build identifies itself here so a stale install is visible without a tool call; compare against \`npm view ${PACKAGE_INFO.name} version\` when freshness matters.

This server DISPROVES. It cannot prove that a document conforms or that a signature is trustworthy.

Read every result as "what could be shown to be wrong, was looked for" — not as a certificate.

How strongly a result can be stated depends on whether the normative text is at hand:

  T1 — ISO 32000-1/-2, ISO 14289 (PDF/UA): the clause can be quoted. State it plainly.
  T2 — ISO 19005 (PDF/A): the standard is NOT in this family's corpus. veraPDF decides.
       Say "veraPDF judged this COMPLIANT", never "conforms to ISO 19005".
  T3 — ETSI EN 319 142 (PAdES B-B / B-T / B-LT / B-LTA): no normative text, and no third-party
       validator either. detect_pades_level OBSERVES structure (timestamp, DSS, coverage of the
       signer) and reports which level that structure matches. That is an observation, not a
       conformance verdict — do not write "conforms to PAdES B-LT".

validate_clauses works in T1: it checks constraints mapped from ISO 32000-1/-2 clauses, which is
the ground veraPDF does not cover — a file can satisfy PDF/A and still violate the specification
body. It reports only what the bundled constraints cover, so no failures means "nothing here
could be disproved", never "conforms". A constraint that depends on a fact outside the file
(whether a font is a subset, say) is returned as needs_external_fact rather than defaulted into
a pass. Some failures are marked as traces: those clauses address the PDF *processor*, so the
file shows that someone broke the rule, not that the last writer did. A failure may also carry a
Context line: the clause is real, but the industry deviates from it on purpose (annotation
QuadPoints winding is the standing example). Report the context with the failure — dropping it
turns a true statement into a misleading one.

Three more limits that get forgotten:
  - Trust. A "valid" verdict without trust_anchors means the cryptography checks out, NOT that
    the signer is who they claim. trust: not_evaluated is reported for exactly this reason.
  - Revocation. If it could not be checked, "not revoked" cannot be claimed either.
  - Non-execution. validate_conformance falls back to a native subset when veraPDF is absent or
    unusable, and says so in authoritativeValidation.performed = false with the reason. A subset
    result is a weaker claim, not a lighter version of the same one: carry the non-execution into
    the report. Omitting it turns "nothing could be disproved" into a pass nobody granted.

evaluate_policy returns a deterministic verdict (trust_and_use / use_with_caution /
human_review_required / reject) from a rule engine over the facts — same facts and profile give
the same verdict. Its advisories never change that verdict; do not treat an advisory as a
failure, or its absence as a pass.

Nothing here judges whether the content is true. A validly signed document can state falsehoods.

For what a specification requires, ask pdf-spec-mcp. For what is inside a file, ask
pdf-reader-mcp.`;

/**
 * 全ツールを登録した MCP サーバを組み立てて返す。
 * トランスポートは繋がない —— どう駆動するかは呼び出し側が決める。
 */
export function buildServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: PACKAGE_INFO.version,
    },
    { instructions: INSTRUCTIONS },
  );

  registerAllTools(server);

  return server;
}
