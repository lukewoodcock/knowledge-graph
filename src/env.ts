/**
 * Reading settings from the environment, shared by the service and its
 * clients (the hooks, /remember, the MCP server and `npm run reindex`).
 */

/** Where the clients find the service unless KG_SERVICE_URL says otherwise. */
export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:5678';

/** The service's base URL from KG_SERVICE_URL, without a trailing slash. */
export function serviceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.KG_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
}

/** A whole number above zero, or `fallback` when the setting is unset or anything else. */
export function positiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
