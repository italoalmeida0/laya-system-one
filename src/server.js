import http from 'node:http';
import { Laya } from './agent.js';

/**
 * Start HTTP server exposing the TypeSafe Jev /v1/systemone wire protocol.
 * @param {Object} options - Server options:
 *   - host: string (default: '0.0.0.0' or process.env.HOST)
 *   - port: number (default: 8080 or process.env.PORT)
 *   - apiKey: string (optional, or process.env.LAYA_API_KEY / process.env.API_KEY)
 *   - laya: preloaded Laya instance (optional)
 *   - device: 'auto' | 'webgpu' | 'wasm' | 'cpu' (default: 'auto')
 * @returns {Promise<{ server: http.Server, url: string, laya: object, close: Function }>}
 */
export async function serve(options = {}) {
  const host = options.host || process.env.HOST || '0.0.0.0';
  // `port: 0` means "pick a free port" — it must not be treated as unset.
  const portRaw = options.port ?? process.env.PORT;
  const parsed = Number.parseInt(portRaw ?? '8080', 10);
  const port = Number.isFinite(parsed) ? parsed : 8080;
  const apiKey = options.apiKey || process.env.LAYA_API_KEY || process.env.API_KEY || null;
  // When we create the engine ourselves we also own its lifecycle: close()
  // must release it (the native backend spawns a laya-serve child process —
  // leaving it alive keeps the Node event loop busy and the process hangs
  // forever after the HTTP server is done).
  const ownsLaya = !options.laya;
  // The engine runs its own internal HTTP server (native backend). It must
  // never share the public port: on Windows two sockets CAN bind the same
  // address (SO_REUSEADDR), so requests would reach the wrong server and
  // shutdown would look broken. Keep it on a private loopback port.
  const laya = options.laya || (await Laya.load({ ...options, host: '127.0.0.1', port: 0 }));

  // End-to-end warmup: first real predict() pays tokenizer-cache fill +
  // any remaining lazy init. Do it once at startup (best-effort) so the
  // first Tetris piece doesn't eat the cold-start cost.
  if (!options.laya && options.warmup !== false) {
    try {
      await laya.predict('warmup', { w: { type: 'noul', instructions: 'warmup probe' } });
    } catch { /* best-effort */ }
  }

  const server = http.createServer((req, res) => {
    // Standard CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Healthcheck endpoint
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        model: 'laya-multilingual',
        version: '1.0.0',
        protocol: 'TypeSafe Jev /v1/systemone compatible'
      }));
      return;
    }

    // TypeSafe Jev evaluation endpoint
    if (req.method === 'POST' && url.pathname === '/v1/systemone') {
      // Optional bearer token authentication
      if (apiKey) {
        const authHeader = req.headers['authorization'] || '';
        if (authHeader !== `Bearer ${apiKey}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Unauthorized: missing or invalid bearer token in Authorization header.'
          }));
          return;
        }
      }

      const chunks = [];
      let size = 0;
      req.on('data', chunk => {
        chunks.push(chunk);
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { // 4MB guard
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large (max 4MB).' }));
          req.destroy();
        }
      });

      req.on('end', async () => {
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Unprocessable Entity: invalid JSON payload.'
          }));
          return;
        }

        const state = payload.state;
        const questions = payload.questions;
        const requestedModel = payload.model || null;

        if (state === undefined || state === null) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: "Unprocessable Entity: missing required 'state' field."
          }));
          return;
        }

        if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: "Unprocessable Entity: 'questions' must be an object map of typed questions."
          }));
          return;
        }

        try {
          const result = await laya.predict(state, questions, requestedModel);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: `Evaluation failed: ${err.message || err}`
          }));
        }
      });
      return;
    }

    // 404 handler
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: `Not found: ${req.method} ${url.pathname}. Expected POST /v1/systemone`
    }));
  });

  // Keep-alive tuning: game clients (Tetris) fire one request per piece on
  // the same connection. Long keep-alive avoids TCP+handshake per move.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 0;
  server.maxRequestsPerSocket = 0;

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const displayHost = host === '0.0.0.0' ? 'localhost' : host;
      // use the port actually bound (0 means "any free port")
      const boundPort = server.address()?.port ?? port;
      const url = `http://${displayHost}:${boundPort}`;
      resolve({
        server,
        url,
        laya,
        close: async () => {
          await new Promise((resolve) => {
            server.close(() => resolve());
            // Node keeps idle keep-alive sockets open (undici pools them for
            // seconds), which would block server.close() — force them shut so
            // shutdown is immediate and deterministic.
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
          });
          if (ownsLaya && typeof laya.close === 'function') await laya.close();
        }
      });
    });
    server.on('error', reject);
  });
}
