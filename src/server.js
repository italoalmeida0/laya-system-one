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
 * @returns {Promise<{ server: http.Server, url: string, close: Function }>}
 */
export async function serve(options = {}) {
  const host = options.host || process.env.HOST || '0.0.0.0';
  const port = parseInt(options.port || process.env.PORT || '8080', 10);
  const apiKey = options.apiKey || process.env.LAYA_API_KEY || process.env.API_KEY || null;
  const laya = options.laya || (await Laya.load(options));

  const server = http.createServer(async (req, res) => {
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

      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });

      req.on('end', async () => {
        let payload;
        try {
          payload = JSON.parse(body);
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

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const displayHost = host === '0.0.0.0' ? 'localhost' : host;
      const url = `http://${displayHost}:${port}`;
      resolve({ server, url, close: () => server.close() });
    });
    server.on('error', reject);
  });
}
