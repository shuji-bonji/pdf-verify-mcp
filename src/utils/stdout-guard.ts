/**
 * stdout guard (side-effect only).
 *
 * MCP speaks JSON-RPC over stdout, so any stray `console.log` / `console.warn`
 * from a dependency corrupts the stream. This module redirects both to stderr.
 *
 * It MUST be imported as the very first import in the entrypoint. ESM hoists
 * all `import` statements before top-level statements, so putting the
 * reassignment inline in index.ts would run it AFTER dependency modules are
 * evaluated. Isolating it in its own module and importing it first guarantees
 * the guard is installed before any other module is loaded.
 */

console.log = (...args: unknown[]) => console.error('[log]', ...args);
console.warn = (...args: unknown[]) => console.error('[warn]', ...args);
