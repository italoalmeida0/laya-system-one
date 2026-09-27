/**
 * Environment access that works in Node, Bun and the browser.
 *
 * `process` does not exist in a browser, and reaching for `process.env.X`
 * directly throws a ReferenceError before any of the fallback logic can run -
 * which is why `import { Laya } from 'laya-system-one'` in a browser failed
 * with a message that had nothing to do with the actual problem.
 *
 * Everything that reads configuration goes through here instead.
 */

/** True when running somewhere with Node-style globals (Node, Bun, Deno). */
export const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node);

/** True when running in a browser-like environment. */
export const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

/** Read an environment variable, or undefined when there is no environment. */
export function env(name) {
  if (typeof process === 'undefined' || !process.env) return undefined;
  return process.env[name];
}

/** Read an environment variable as an integer, or null when unset/invalid. */
export function envInt(name) {
  const raw = env(name);
  if (raw === undefined || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * The backend to use when the caller did not pick one.
 *
 * `native` spawns a process, so it is only ever right where there is one; a
 * browser must get `wasm`. Defaulting to `native` everywhere made the
 * documented browser example fail on import.
 */
export function defaultBackend() {
  const configured = env('LAYA_BACKEND');
  if (configured) return configured;
  return isBrowser || !isNode ? 'wasm' : 'native';
}
