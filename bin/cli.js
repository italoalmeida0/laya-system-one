#!/usr/bin/env node

import { serve } from '../src/server.js';

const args = process.argv.slice(2);

function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return defaultValue;
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Laya System-One Decision Engine (TypeSafe Jev Wire-Compatible)
High-performance, self-contained inference server with WebGPU and WASM support.

Usage:
  npx laya-system-one [options]

Options:
  --port <number>       HTTP port to bind (default: 8080 or PORT env)
  --host <string>       Host to bind (default: 0.0.0.0 or HOST env)
  --device <type>       Acceleration device: auto | webgpu | wasm | cpu (default: auto)
  --api-key <string>    Require Bearer token authentication (optional)
  --help, -h            Show this help message

Endpoints:
  POST /v1/systemone    Evaluate typed decisions (TypeSafe Jev wire protocol)
  GET  /health          Server healthcheck probe

Example:
  npx laya-system-one --port 8080 --device auto
`);
  process.exit(0);
}

const port = parseInt(getArg('--port', process.env.PORT || '8080'), 10);
const host = getArg('--host', process.env.HOST || '0.0.0.0');
const device = getArg('--device', process.env.DEVICE || 'auto');
const apiKey = getArg('--api-key', process.env.LAYA_API_KEY || process.env.API_KEY || null);

console.log('='.repeat(68));
console.log('       LAYA SYSTEM-ONE DECISION SERVER (JEV COMPATIBLE)        ');
console.log('='.repeat(68));
console.log(`Hardware Acceleration : ${device.toUpperCase()} (WebGPU -> Native CPU/WASM)`);
console.log(`Authentication        : ${apiKey ? 'Enabled (Bearer token required)' : 'Disabled (Open local)'}`);
console.log(`Binding               : ${host}:${port}`);
console.log('-'.repeat(68));

try {
  const { url } = await serve({ host, port, device, apiKey });
  console.log(`✓ Laya System-One server active and ready!`);
  console.log(`✓ Jev Evaluation Endpoint : ${url}/v1/systemone`);
  console.log(`✓ Healthcheck Endpoint   : ${url}/health`);
  console.log('-'.repeat(68));
  console.log('Quick verification (cURL):');
  console.log(`curl -X POST ${url}/v1/systemone \\`);
  console.log('  -H "Content-Type: application/json" \\');
  if (apiKey) {
    console.log(`  -H "Authorization: Bearer ${apiKey}" \\`);
  }
  console.log('  -d \'{');
  console.log('    "state": "We were billed twice on March invoice.",');
  console.log('    "model": "laya-multilingual",');
  console.log('    "questions": {');
  console.log('      "department": {');
  console.log('        "type": "choice",');
  console.log('        "instructions": "Which department should handle this?",');
  console.log('        "criteria": { "billing": "refunds and invoices", "tech": "bugs" }');
  console.log('      }');
  console.log('    }');
  console.log('  }\'');
  console.log('='.repeat(68));
  console.log('Press Ctrl+C to stop the server.');
} catch (err) {
  console.error('Failed to start server:', err);
  process.exit(1);
}
