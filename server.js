import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { pool, initSchema } from './db.js';

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
  const cleanUrl = req.url.split('?')[0];
  let filePath = path.join(__dirname, cleanUrl === '/' ? 'index.html' : cleanUrl);
  // Prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
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

// ── Hypotheses endpoint ───────────────────────────────────────────────────────
async function handleHypotheses(req, res) {
  const niche = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/niche.json'), 'utf8'));
  const [hypoRes, adsRes, allAdsRes] = await Promise.all([
    pool.query('SELECT * FROM hypotheses ORDER BY generated_at DESC'),
    pool.query('SELECT COUNT(*) FROM ads_analysis'),
    pool.query('SELECT data FROM ads_analysis ORDER BY (data->>\'_score\')::float DESC NULLS LAST'),
  ]);

  // Build refs map from sorted ads
  const sortedAds = allAdsRes.rows.map(r => r.data);
  const refs = {};
  sortedAds.forEach((ad, i) => {
    const num = i + 1;
    if (ad.Image?.[0]?.url) {
      refs[num] = {
        ad_id:       ad.ID,
        image_url:   ad.Image[0].url,
        reach:       ad['EU Total Reach'] ?? 0,
        active_days: ad['Active days']    ?? 0,
        status:      ad.Status,
        behavior:    ad._behavior ?? null,
      };
    }
  });

  const allHypotheses = hypoRes.rows.map(r => ({
    id:                   r.hypo_id,
    _db_id:               r.id,
    title:                r.title,
    hypothesis:           r.hypothesis,
    what_to_test:         r.what_to_test,
    based_on:             r.based_on,
    why_it_works:         r.why_it_works,
    priority:             r.priority,
    creative_format:      r.creative_format,
    reference_ad_numbers: r.reference_ad_numbers,
    top_hooks:            r.top_hooks,
    top_body_texts:       r.top_body_texts,
    visual_prompt:        r.visual_prompt,
    tested:               r.tested,
    asana_created:        r.asana_created,
    generated_at:         r.generated_at,
    batch:                r.batch,
  }));

  // Group by batch, newest first
  const batchMap = new Map();
  allHypotheses.forEach(h => {
    if (!batchMap.has(h.batch)) batchMap.set(h.batch, []);
    batchMap.get(h.batch).push(h);
  });
  const batches = [...batchMap.entries()]
    .sort((a, b) => new Date(b[0]) - new Date(a[0]))
    .map(([batch, hypotheses]) => ({ batch, hypotheses }));

  const payload = {
    generated_at: batches[0]?.batch ?? new Date().toISOString(),
    direction:    niche.direction,
    based_on_ads: parseInt(adsRes.rows[0].count),
    batches,
    hypotheses:   batches[0]?.hypotheses ?? [],
    refs,
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// ── Tested state endpoint ─────────────────────────────────────────────────────
function handleTestedToggle(req, res) {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    const { _db_id, tested } = JSON.parse(body);
    await pool.query('UPDATE hypotheses SET tested = $1 WHERE id = $2', [!!tested, _db_id]);
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

    const hooks  = (h.top_hooks ?? []).map((hk, i) => `_${i + 1}. ${hk.text}_`).join('\n');
    const bodies = (h.top_body_texts ?? []).map((b, i) => `_${i + 1}. ${b.text}_`).join('\n\n');

    const notes = [
      h.share_url     ? `🔗 ${h.share_url}`                      : '',
      h.hypothesis    ? `**Hypothesis:**\n${h.hypothesis}`       : '',
      h.what_to_test  ? `**What to test:**\n${h.what_to_test}`   : '',
      h.why_it_works  ? `**Why it works:**\n${h.why_it_works}`   : '',
      hooks           ? `**Top Hooks:**\n${hooks}`                : '',
      bodies          ? `**Top Body Texts:**\n${bodies}`          : '',
      h.visual_prompt ? `**Visual Prompt:**\n\`\`\`\n${h.visual_prompt}\n\`\`\`` : '',
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

    if (asanaRes.ok && result.data?.gid && h._db_id) {
      await pool.query('UPDATE hypotheses SET asana_created = TRUE WHERE id = $1', [h._db_id]);
    }

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

  const urlPath = req.url.split('?')[0];
  if (req.method === 'GET'  && urlPath === '/api/ping') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,url:req.url})); return; }
  if (req.method === 'GET'  && urlPath === '/api/hypotheses')      { handleHypotheses(req, res).catch(e => { res.writeHead(500); res.end(e.message); }); return; }
  if (req.method === 'POST' && urlPath === '/api/tested')         { handleTestedToggle(req, res); return; }
  if (req.method === 'GET'  && urlPath === '/api/asana/project') { handleAsanaProject(res); return; }
  if (req.method === 'POST' && urlPath === '/api/asana')          { handleAsanaCreate(req, res); return; }
  if (req.method === 'POST' && urlPath === '/api/generate')       { handleGenerate(res); return; }

  serveStatic(req, res);
});

initSchema().then(() => {
  server.listen(PORT, () => {
    console.log(`UltraHypo dev server: http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});
