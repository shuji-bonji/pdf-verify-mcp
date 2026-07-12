/**
 * Logger Utility
 * Centralized logging abstraction (shuji-mcp-patterns Pattern C).
 *
 * All output goes to stderr — stdout is reserved for the MCP stdio protocol.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface Logger {
  debug(context: string, message: string): void;
  info(context: string, message: string): void;
  warn(context: string, message: string): void;
  error(context: string, message: string, error?: Error): void;
}

function formatMessage(context: string, message: string): string {
  return `[${context}] ${message}`;
}

export const logger: Logger = {
  debug(context, message) {
    if (process.env.DEBUG) {
      console.error(formatMessage(context, message));
    }
  },
  info(context, message) {
    console.error(formatMessage(context, message));
  },
  warn(context, message) {
    console.error(formatMessage(context, message));
  },
  error(context, message, error) {
    console.error(formatMessage(context, message), error ?? '');
  },
};
