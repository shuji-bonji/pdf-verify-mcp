/**
 * Tool registration.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDetectPadesLevel } from './detect-pades-level.js';
import { registerEvaluatePolicy } from './evaluate-policy.js';
import { registerIdentifyConformance } from './identify-conformance.js';
import { registerValidateConformance } from './validate-conformance.js';
import { registerVerifyIntegrity } from './verify-integrity.js';
import { registerVerifySignatures } from './verify-signatures.js';

export function registerAllTools(server: McpServer): void {
  registerVerifySignatures(server);
  registerVerifyIntegrity(server);
  registerDetectPadesLevel(server);
  registerIdentifyConformance(server);
  registerValidateConformance(server);
  registerEvaluatePolicy(server);
}
