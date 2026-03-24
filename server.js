import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

// ── Static file server ────────────────────────────────────────────────────────
function serveStatic(req, res) {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  // Prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(data);
  });
}

// ── SSE generate endpoint ─────────────────────────────────────────────────────
function handleGenerate(res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('log', { msg: 'Starting hypothesis generation...' });

  // Only step 3 — fetch+analyze are run locally and committed to git
  const steps = [
    { cmd: 'node', args: ['scripts/3-generate.js'], label: '[1/1] Generating hypotheses...' },
  ];

  let stepIdx = 0;

  function runNext() {
    if (stepIdx >= steps.length) {
      send('done', { msg: 'Done! Loading new hypotheses...' });
      res.end();
      return;
    }
    const step = steps[stepIdx++];
    send('log', { msg: step.label });

    const proc = spawn(step.cmd, step.args, { cwd: __dirname });
    const errLines = [];

    proc.stdout.on('data', d =>
      String(d).split('\n').filter(Boolean).forEach(line => send('log', { msg: line }))
    );
    proc.stderr.on('data', d =>
      String(d).split('\n').filter(Boolean).forEach(line => {
        errLines.push(line);
        send('log', { msg: line });
      })
    );
    proc.on('close', code => {
      if (code !== 0) {
        const detail = errLines.slice(0, 4).join(' | ') || 'no output';
        send('error', { msg: `${step.label} failed:\n${detail}` });
        res.end();
      } else {
        runNext();
      }
    });
  }

  runNext();
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST' });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/generate') {
    handleGenerate(res);
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`UltraHypo dev server: http://localhost:${PORT}`);
});
