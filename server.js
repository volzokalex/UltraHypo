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

// ── Tested state endpoint ─────────────────────────────────────────────────────
const HYPO_FILE = path.join(__dirname, 'data/hypotheses.json');

function handleTestedToggle(req, res) {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const { id, tested } = JSON.parse(body);
    const data = JSON.parse(fs.readFileSync(HYPO_FILE, 'utf8'));
    data.hypotheses = data.hypotheses.map(h =>
      h.id === id ? { ...h, tested: !!tested } : h
    );
    fs.writeFileSync(HYPO_FILE, JSON.stringify(data, null, 2));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

// ── Asana endpoints ───────────────────────────────────────────────────────────
const ASANA_TOKEN   = process.env.ASANA_TOKEN;
const ASANA_PROJECT = process.env.ASANA_PROJECT_GID;
const ASANA_API     = 'https://app.asana.com/api/1.0';

async function asanaGet(path) {
  const res = await fetch(`${ASANA_API}${path}`, {
    headers: { Authorization: `Bearer ${ASANA_TOKEN}` }
  });
  return res.json();
}

async function handleAsanaProject(res) {
  if (!ASANA_TOKEN || !ASANA_PROJECT) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Asana not configured' }));
    return;
  }
  const data = await asanaGet(`/projects/${ASANA_PROJECT}?opt_fields=name`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ name: data.data?.name ?? 'Asana Project' }));
}

async function handleAsanaCreate(req, res) {
  if (!ASANA_TOKEN || !ASANA_PROJECT) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Asana not configured' }));
    return;
  }

  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    const h = JSON.parse(body);

    const hooks = (h.top_hooks ?? []).map((hk, i) => `${i + 1}. ${hk.text}`).join('\n');
    const bodies = (h.top_body_texts ?? []).map((b, i) => `${i + 1}. ${b.text}`).join('\n\n');

    const notes = [
      h.hypothesis      ? `Hypothesis:\n${h.hypothesis}`         : '',
      h.what_to_test    ? `What to test:\n${h.what_to_test}`     : '',
      h.why_it_works    ? `Why it works:\n${h.why_it_works}`     : '',
      hooks             ? `Top Hooks:\n${hooks}`                  : '',
      bodies            ? `Top Body Texts:\n${bodies}`            : '',
      h.visual_prompt   ? `Visual Prompt:\n${h.visual_prompt}`   : '',
    ].filter(Boolean).join('\n\n---\n\n');

    const payload = {
      data: {
        name:      h.title,
        notes,
        projects:  [ASANA_PROJECT],
      }
    };

    const asanaRes = await fetch(`${ASANA_API}/tasks`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${ASANA_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const result = await asanaRes.json();

    res.writeHead(asanaRes.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ task_url: `https://app.asana.com/0/${ASANA_PROJECT}/${result.data?.gid}` }));
  });
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET' });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/tested')         { handleTestedToggle(req, res); return; }
  if (req.method === 'GET'  && req.url === '/api/asana/project') { handleAsanaProject(res); return; }
  if (req.method === 'POST' && req.url === '/api/asana')          { handleAsanaCreate(req, res); return; }
  if (req.method === 'POST' && req.url === '/api/generate')       { handleGenerate(res); return; }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`UltraHypo dev server: http://localhost:${PORT}`);
});
