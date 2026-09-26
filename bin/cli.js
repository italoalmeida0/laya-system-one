#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { serve } from '../src/server.js';

const args = process.argv.slice(2);

function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return defaultValue;
}

function pkgVersion() {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const HELP = `
Laya System-One Decision Engine (TypeSafe Jev wire-compatible)

Usage:
  npx laya-system-one [options]

Options:
  --port <number>       HTTP port to bind (default: 8080 or PORT env)
  --host <string>       Host to bind (default: 0.0.0.0 or HOST env)
  --backend <type>      Inference backend: native | ort | wasm (default: native)
  --device <type>       ort device hint: auto | cpu (default: auto)
  --api-key <string>    Require Bearer token authentication (optional)
  --help, -h            Show this help message
  --version, -v         Print the package version

Backends:
  native   self-contained laya-serve binary (fastest, zero dependencies)
  ort      onnxruntime Node bindings (cross-platform fallback)
  wasm     pure-Rust tract wasm (browser / extreme portability)

Endpoints:
  POST /v1/systemone    Evaluate typed decisions (TypeSafe Jev wire protocol)
  GET  /health          Server healthcheck probe

Example:
  npx laya-system-one --port 8080
`;

if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(pkgVersion());
  process.exit(0);
}

const port = parseInt(getArg('--port', process.env.PORT || '8080'), 10);
const host = getArg('--host', process.env.HOST || '0.0.0.0');
const backend = getArg('--backend', process.env.LAYA_BACKEND || 'native');
const device = getArg('--device', process.env.DEVICE || 'auto');
const apiKey = getArg('--api-key', process.env.LAYA_API_KEY || process.env.API_KEY || null);

console.log('='.repeat(68));
console.log('       LAYA SYSTEM-ONE DECISION SERVER (JEV COMPATIBLE)        ');
console.log('='.repeat(68));
console.log(`Backend               : ${backend}`);
console.log(`Authentication        : ${apiKey ? 'Enabled (Bearer token required)' : 'Disabled (Open local)'}`);
console.log(`Binding               : ${host}:${port}`);
console.log('-'.repeat(68));

let srv = null;

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  try {
    if (srv) await srv.close();
    console.log('✓ shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('shutdown error:', err?.message || err);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  srv = await serve({ host, port, device, backend, apiKey });
  console.log(`✓ Laya System-One server active and ready!`);
  console.log(`✓ Jev Evaluation Endpoint : ${srv.url}/v1/systemone`);
  console.log(`✓ Healthcheck Endpoint   : ${srv.url}/health`);
  console.log('-'.repeat(68));
  console.log('Quick verification (cURL):');
  console.log(`curl -X POST ${srv.url}/v1/systemone \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  if (apiKey) {
    console.log(`  -H "Authorization: Bearer ${apiKey}" \\`);
  }
  console.log(`  -d '{`);
  console.log(`    "state": "We were billed twice on March invoice.",`);
  console.log(`    "model": "laya-multilingual",`);
  console.log(`    "questions": {`);
  console.log(`      "department": {`);
  console.log(`        "type": "choice",`);
  console.log(`        "instructions": "Which department should handle this?",`);
  console.log(`        "criteria": { "billing": "refunds and invoices", "tech": "bugs" }`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }'`);
  console.log('='.repeat(68));
  console.log('Press Ctrl+C to stop the server.');
} catch (err) {
  console.error('Failed to start server:', err);
  process.exit(1);
}
