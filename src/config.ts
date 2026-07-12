/**
 * Application Configuration
 * Centralized configuration management.
 *
 * Version is dynamically loaded from package.json (shuji-mcp-patterns Pattern B)
 * so that `npm version` bumps never go out of sync with the server metadata.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { name: string; version: string };

/** Package information (dynamically loaded from package.json) */
export const PACKAGE_INFO = {
  name: packageJson.name,
  version: packageJson.version,
} as const;

/** Short server name used in logs and MCP handshake */
export const SERVER_NAME = 'pdf-verify-mcp';
