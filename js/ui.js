// ── Labels ────────────────────────────────────────────────────────────────────
const L = {
  based_on:       'Based on',
  all_hypotheses: 'All hypotheses',
  no_data:        'No hypotheses found.',
  hypothesis:     'Hypothesis',
  what_to_test:   'What to test',
  why_it_works:   'Why it works',
  top_hooks:      'Top Hooks',
  top_body:       'Top Body Texts',
  visual_prompt:  'Visual Prompt',
  generate:       '✦ Generate Hypotheses',
  reach:          'Reach',
  days:           'Active days',
  active:         'Active',
  inactive:       'Inactive',
};

// ── State ─────────────────────────────────────────────────────────────────────
let hypotheses   = [];
let batches      = [];
let adsRefs      = {};
let current      = 0;
let asanaProject = null; // loaded once on init

function fmtBatchLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ── Tested state (server-side, hypotheses.json) ───────────────────────────────
function isTestedLocal(id) {
  const h = hypotheses.find(h => h.id === id);
  return h?.tested ?? false;
}

async function setTested(h, tested) {
  h.tested = tested;
  fetch('/api/tested', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ _db_id: h._db_id, tested }),
  }).catch(() => {});
}

// ── DOM ───────────────────────────────────────────────────────────────────────
const metaEl      = document.getElementById('meta');
const emptyEl     = document.getElementById('empty-state');
const centerEl    = document.getElementById('panel-center');
const refAdsEl    = document.getElementById('ref-ads');
const navPillsEl  = document.getElementById('nav-pills');
const btnGenerate = document.getElementById('btn-generate');

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtReach = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : String(n);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Format text: preserve line breaks, style bullet lines
function formatText(text) {
  return String(text).split('\n').map(line => {
    const e = esc(line);
    return line.startsWith('•') || line.startsWith('-')
      ? `<span class="bullet-line">${e}</span>`
      : e;
  }).join('\n');
}

function fmtBadge(fmt) {
  const cls = `badge-fmt-${(fmt ?? 'image').toLowerCase()}`;
  return `<span class="badge-fmt ${cls}">${esc(fmt ?? 'image')}</span>`;
}

// ── Copy button ───────────────────────────────────────────────────────────────
function copyBtn(text) {
  return `<button class="btn-copy" data-copy="${esc(text)}" title="Copy">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="9" y="9" width="13" height="13" rx="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
  </button>`;
}

function wireCopyButtons(container) {
  container.querySelectorAll('.btn-copy').forEach(btn => {
    btn.addEventListener('click', e => {
      const text = e.currentTarget.dataset.copy;
      navigator.clipboard.writeText(text).catch(() => {});
      e.currentTarget.classList.add('copied');
      setTimeout(() => e.currentTarget.classList.remove('copied'), 1200);
    });
  });
}

// ── Carousel ──────────────────────────────────────────────────────────────────
function makeCarousel(titleKey, items) {
  if (!items?.length) return '';
  const id = 'car-' + Math.random().toString(36).slice(2);
  let idx = 0;

  function html() {
    const item = items[idx];
    return `<div class="carousel-wrap" id="${id}">
      <div class="carousel-header">
        <span class="carousel-title">${L[titleKey]}</span>
      </div>
      <div class="carousel-body">
        <div class="carousel-text${item.is_dialog ? ' is-dialog' : ''}">${formatText(item.text)}</div>
      </div>
      <div class="carousel-footer">
        <div class="carousel-controls">
          <button class="car-prev"${idx===0?' disabled':''}>←</button>
          <span class="carousel-counter">${fmtBadge(item.format)} ${idx+1} / ${items.length}</span>
          <button class="car-next"${idx===items.length-1?' disabled':''}>→</button>
        </div>
        ${copyBtn(item.text)}
      </div>
    </div>`;
  }

  setTimeout(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelector('.car-prev')?.addEventListener('click', () => { if(idx>0){idx--;refresh();} });
    el.querySelector('.car-next')?.addEventListener('click', () => { if(idx<items.length-1){idx++;refresh();} });
    wireCopyButtons(el);

    function refresh() {
      const item = items[idx];
      el.querySelector('.carousel-text').className = `carousel-text${item.is_dialog?' is-dialog':''}`;
      el.querySelector('.carousel-text').innerHTML = formatText(item.text);
      el.querySelector('.carousel-counter').innerHTML = `${fmtBadge(item.format)} ${idx+1} / ${items.length}`;
      el.querySelector('.car-prev').disabled = idx === 0;
      el.querySelector('.car-next').disabled = idx === items.length - 1;
      el.querySelector('.btn-copy').dataset.copy = esc(item.text);
    }
  }, 0);

  return html();
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(url) {
  const lb = document.getElementById('lightbox');
  document.getElementById('lightbox-img').src = url;
  lb.classList.add('open');
}

// ── Nav pills ─────────────────────────────────────────────────────────────────
function renderNavPills() {
  navPillsEl.innerHTML = hypotheses.map((h, i) => {
    const isTested = h.tested ?? false;
    const cls = [
      'nav-pill',
      i === current ? 'active' : '',
      isTested ? 'tested' : '',
    ].filter(Boolean).join(' ');
    return `<button class="${cls}" data-idx="${i}">${esc(h.title)}</button>`;
  }).join('');
  navPillsEl.querySelectorAll('.nav-pill').forEach(btn =>
    btn.addEventListener('click', () => { current = +btn.dataset.idx; renderAll(); })
  );
}

// ── Ref ads panel ─────────────────────────────────────────────────────────────
function renderRefAds(h) {
  const nums = (h.reference_ad_numbers ?? []).filter(n => adsRefs[n]);
  if (!nums.length) {
    refAdsEl.innerHTML = `<p style="font-size:12px;color:var(--muted)">No image refs</p>`;
    return;
  }
  refAdsEl.innerHTML = nums.map(num => {
    const ad = adsRefs[num];
    const statusCls = ad.status === 'ACTIVE' ? 'active' : 'inactive';
    return `<div class="ref-card" data-img="${esc(ad.image_url)}">
      <img src="${esc(ad.image_url)}" alt="Ad ${esc(ad.ad_id)}" loading="lazy" onerror="this.outerHTML='<div style=\'height:160px;background:#1a1a2e;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#555\'>Image expired</div>'" />
      <div class="ref-card-body">
        <div class="ref-card-stat"><span>${L.reach}</span><span>${fmtReach(ad.reach)}</span></div>
        <div class="ref-card-stat"><span>${L.days}</span><span>${ad.active_days}</span></div>
        <span class="ref-status ${statusCls}">${ad.status === 'ACTIVE' ? L.active : L.inactive}</span>
      </div>
    </div>`;
  }).join('');

  refAdsEl.querySelectorAll('.ref-card[data-img]').forEach(card =>
    card.addEventListener('click', () => openLightbox(card.dataset.img))
  );
}

// ── Center hypothesis ─────────────────────────────────────────────────────────
function renderHypothesis() {
  const h = hypotheses[current];
  const priorityClass = h.priority === 'high' ? 'badge-high' : 'badge-medium';
  const tested = h.tested ?? false;

  const visualBlock = h.visual_prompt ? `
    <div class="visual-prompt-block">
      <div class="section-label">${L.visual_prompt}</div>
      <div class="visual-prompt-text">${esc(h.visual_prompt)}</div>
      <div class="visual-prompt-footer">${copyBtn(h.visual_prompt)}</div>
    </div>` : '';

  const checkSvg = `<svg class="tested-check-icon" viewBox="0 0 10 8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="1,4 4,7 9,1"/></svg>`;

  const asanaCreated = h.asana_created ?? false;
  const asanaBtn = asanaProject
    ? `<button class="btn-asana${asanaCreated ? ' is-created' : ''}" title="Add to Asana"${asanaCreated ? ' disabled' : ''}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="6" r="4"/><circle cx="5" cy="17" r="4"/><circle cx="19" cy="17" r="4"/></svg>
        ${asanaCreated ? '✓ Created' : 'Add to Asana'}
      </button>`
    : '';

  centerEl.innerHTML = `
    <div class="hypo-wrap" style="position:relative">
      <div class="hypo-actions">
        ${asanaBtn}
        <label class="tested-label${tested ? ' is-tested' : ''}" title="Mark as tested">
          <input type="checkbox" class="tested-cb"${tested ? ' checked' : ''} />
          <span class="tested-check-box">${checkSvg}</span>
          Tested
        </label>
      </div>

      <div class="badges">
        <span class="badge ${priorityClass}">● ${h.priority}</span>
        <span class="badge badge-format">${esc(h.creative_format ?? 'image')}</span>
        <button class="btn-share" title="Copy link" data-dbid="${h._db_id}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
      </div>

      <div class="hypo-title">${esc(h.title)}</div>

      <div class="section">
        <div class="section-label">${L.hypothesis}</div>
        <div class="section-text">${esc(h.hypothesis)}</div>
      </div>

      <div class="section">
        <div class="section-label">${L.what_to_test}</div>
        <div class="section-text">${esc(h.what_to_test)}</div>
      </div>

      <div class="section">
        <div class="section-label">${L.why_it_works}</div>
        <div class="section-text">${esc(h.why_it_works)}</div>
      </div>

      ${makeCarousel('top_hooks', h.top_hooks)}
      ${makeCarousel('top_body',  h.top_body_texts)}
      ${visualBlock}
    </div>`;

  wireCopyButtons(centerEl);

  // Wire share button
  const shareBtnEl = centerEl.querySelector('.btn-share');
  shareBtnEl?.addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}?h=${h._db_id}`;
    navigator.clipboard.writeText(url).then(() => showToast('Copied', shareBtnEl));
  });

  // Wire tested checkbox
  const cb = centerEl.querySelector('.tested-cb');
  cb?.addEventListener('change', () => {
    setTested(h, cb.checked);
    cb.closest('.tested-label').classList.toggle('is-tested', cb.checked);
    renderNavPills();
  });

  // Wire Asana button
  const asanaBtnEl = centerEl.querySelector('.btn-asana');
  asanaBtnEl?.addEventListener('click', async () => {
    if (!confirm(`Create task in "${asanaProject}"?\n\n${h.title}`)) return;
    asanaBtnEl.disabled = true;
    asanaBtnEl.textContent = 'Creating...';
    try {
      const res = await fetch('/api/asana', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...h, share_url: `${location.origin}${location.pathname}?h=${h._db_id}` }),
      });
      const data = await res.json();
      if (data.task_url) {
        h.asana_created = true;
        asanaBtnEl.disabled = true;
        asanaBtnEl.classList.add('is-created');
        asanaBtnEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="6" r="4"/><circle cx="5" cy="17" r="4"/><circle cx="19" cy="17" r="4"/></svg> ✓ Created`;
        setTimeout(() => window.open(data.task_url, '_blank'), 300);
      } else {
        throw new Error(data.error ?? 'Failed');
      }
    } catch (e) {
      asanaBtnEl.disabled = false;
      asanaBtnEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="6" r="4"/><circle cx="5" cy="17" r="4"/><circle cx="19" cy="17" r="4"/></svg> Add to Asana`;
      alert('Asana error: ' + e.message);
    }
  });
}

// ── Render all ────────────────────────────────────────────────────────────────
function renderAll() {
  renderHypothesis();
  renderNavPills();
  renderRefAds(hypotheses[current]);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Load hypothesis data ──────────────────────────────────────────────────────
async function loadData() {
  const res = await fetch('/api/hypotheses', { cache: 'no-store' });
  if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`HTTP ${res.status} – ${body.slice(0, 120) || 'empty response'}`); }

  const data = await res.json();
  batches    = data.batches ?? [];
  hypotheses = data.hypotheses ?? [];
  adsRefs    = data.refs ?? {};

  const date = new Date(data.generated_at).toLocaleDateString('en-GB');
  metaEl.textContent = `${data.direction} · ${data.based_on_ads} ads · ${date}`;

  // Restore from URL ?h= param
  const targetId = parseInt(new URLSearchParams(location.search).get('h'));
  if (targetId) {
    // Search across all batches
    for (let bi = 0; bi < batches.length; bi++) {
      const idx = batches[bi].hypotheses.findIndex(x => x._db_id === targetId);
      if (idx !== -1) { hypotheses = batches[bi].hypotheses; current = idx; break; }
    }
  } else {
    current = 0;
  }

  emptyEl?.remove();
  renderAll();
  buildHistorySelect();
  return data;
}


// ── History selector ──────────────────────────────────────────────────────────
function buildHistorySelect() {
  document.getElementById('history-wrap')?.remove();
  if (batches.length < 2) return;

  const wrap = document.createElement('div');
  wrap.id = 'history-wrap';
  wrap.style.cssText = 'display:flex;align-items:center;gap:6px';

  const label = document.createElement('span');
  label.style.cssText = 'font-size:11px;color:var(--muted)';
  label.textContent = 'Batch:';

  const sel = document.createElement('select');
  sel.className = 'history-select';
  sel.innerHTML = batches.map((b, i) =>
    `<option value="${i}">${i === 0 ? '● ' : ''}${fmtBatchLabel(b.batch)}</option>`
  ).join('');

  sel.addEventListener('change', () => {
    hypotheses = batches[+sel.value]?.hypotheses ?? [];
    current = 0;
    renderAll();
  });

  wrap.appendChild(label);
  wrap.appendChild(sel);
  document.querySelector('.header-actions').prepend(wrap);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, anchor) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    t.style.left = `${r.left + r.width / 2 + window.scrollX}px`;
    t.style.top  = `${r.top - 8 + window.scrollY}px`;
    t.style.transform = 'translateX(-50%) translateY(-100%)';
    t.style.bottom = 'auto';
  }
  setTimeout(() => t.classList.add('toast-show'), 10);
  setTimeout(() => { t.classList.remove('toast-show'); setTimeout(() => t.remove(), 300); }, 1500);
}

// ── Error modal ───────────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.createElement('div');
  el.id = 'err-modal';
  el.innerHTML = `
    <div class="err-inner">
      <div class="err-title">Generation failed</div>
      <pre class="err-text">${esc(msg)}</pre>
      <div class="err-footer">
        <button class="err-copy">Copy error</button>
        <button class="err-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('.err-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(msg).catch(() => {});
    el.querySelector('.err-copy').textContent = 'Copied!';
  });
  el.querySelector('.err-close').addEventListener('click', () => el.remove());
}

// ── Generate button ───────────────────────────────────────────────────────────
let generating = false;
let progressTimer = null;
let progressPct = 0;

let btnLabelEl = null;

function setBtnGenerating() {
  btnGenerate.innerHTML = `<span class="btn-spinner"></span><span class="btn-label">Cooking... 0%</span>`;
  btnLabelEl = btnGenerate.querySelector('.btn-label');
}

function setProgress(pct) {
  progressPct = Math.min(pct, 99);
  if (btnLabelEl) btnLabelEl.textContent = `Cooking... ${Math.round(progressPct)}%`;
}

function startProgressAnimation() {
  progressPct = 0;
  setBtnGenerating();
  progressTimer = setInterval(() => {
    if (progressPct < 40)      progressPct += 2.5;
    else if (progressPct < 85) progressPct += 0.4;
    else clearInterval(progressTimer);
    if (btnLabelEl) btnLabelEl.textContent = `Cooking... ${Math.round(progressPct)}%`;
  }, 200);
}

function finishProgress() {
  clearInterval(progressTimer);
  if (btnLabelEl) btnLabelEl.textContent = 'Cooking... 100%';
}

function resetButton() {
  clearInterval(progressTimer);
  btnGenerate.disabled = false;
  btnGenerate.textContent = L.generate;
}

btnGenerate.addEventListener('click', async () => {
  if (generating) return;

  const ping = await fetch('/api/generate', { method: 'OPTIONS' }).catch(() => null);
  if (!ping || !ping.ok) {
    alert('Generation requires the local server.\n\nRun: npm run serve');
    return;
  }

  generating = true;
  btnGenerate.disabled = true;
  startProgressAnimation();

  try {
    const resp = await fetch('/api/generate', { method: 'POST' });
    if (!resp.ok) throw new Error('Server error');

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop();

      for (const raw of events) {
        const lines    = raw.split('\n');
        const evtLine  = lines.find(l => l.startsWith('event:'));
        const dataLine = lines.find(l => l.startsWith('data:'));
        if (!dataLine) continue;

        const eventType = evtLine ? evtLine.slice(7).trim() : 'log';
        const payload   = JSON.parse(dataLine.slice(5).trim());

        if (eventType === 'error') {
          showError(payload.msg);
          break outer;
        }
        if (eventType === 'done') {
          finishProgress();
          await loadData();
          buildHistorySelect();
          break outer;
        }
      }
    }
  } catch (e) {
    console.error(e);
    alert('Generation failed: ' + e.message);
  } finally {
    generating = false;
    resetButton();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Lightbox
  const lb = document.createElement('div');
  lb.id = 'lightbox';
  lb.className = 'lightbox';
  lb.innerHTML = '<img id="lightbox-img" />';
  lb.addEventListener('click', () => lb.classList.remove('open'));
  document.body.appendChild(lb);

  // Load Asana project name (only works when server is running)
  fetch('/api/asana/project').then(r => r.ok ? r.json() : null).then(data => {
    if (data?.name) { asanaProject = data.name; if (hypotheses.length) renderHypothesis(); }
  }).catch(() => {});

  try {
    await loadData();
  } catch(e) {
    console.error(e);
    const msg = document.createElement('div');
    msg.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#3a1a1a;color:#f87171;border:1px solid #7f1d1d;padding:12px 20px;border-radius:8px;font-size:13px;max-width:480px;text-align:center;z-index:9999';
    msg.textContent = 'Failed to load: ' + e.message;
    document.body.appendChild(msg);
  }
}

init();
