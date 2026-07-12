#!/usr/bin/env node
/**
 * pdf-verify-mcp - MCP server for PDF authenticity verification.
 *
 * Cryptographic signature verification, tamper detection, PAdES level
 * detection, and conformance declaration identification.
 * Complements pdf-reader-mcp (structure) and pdf-spec-mcp (specification).
 */

// IMPORTANT: Guard stdout before any imports that might log.
// stdout is reserved for the stdio JSON-RPC stream.
console.log = (...args: unknown[]) => console.error('[log]', ...args);
console.warn = (...args: unknown[]) => console.error('[warn]', ...args);

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PACKAGE_INFO, SERVER_NAME } from './config.js';
import { registerAllTools } from './tools/index.js';

const server = new McpServer({
  name: SERVER_NAME,
  version: PACKAGE_INFO.version,
});

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
