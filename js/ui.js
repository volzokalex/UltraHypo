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
let adsRefs      = {};
let current      = 0;
let asanaProject = null; // loaded once on init

// ── Tested state (server-side, hypotheses.json) ───────────────────────────────
function isTestedLocal(id) {
  const h = hypotheses.find(h => h.id === id);
  return h?.tested ?? false;
}

async function setTested(id, tested) {
  // Update local state immediately
  const h = hypotheses.find(h => h.id === id);
  if (h) h.tested = tested;

  // Persist to server (best-effort)
  fetch('/api/tested', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ id, tested }),
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
      <img src="${esc(ad.image_url)}" alt="Ad ${esc(ad.ad_id)}" loading="lazy" />
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

  // Wire tested checkbox
  const cb = centerEl.querySelector('.tested-cb');
  cb?.addEventListener('change', () => {
    setTested(h.id, cb.checked);
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
        body:    JSON.stringify(h),
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
async function loadData(url = 'data/hypotheses.json', refsUrl = 'data/ads-refs.json') {
  const [hypoRes, refsRes] = await Promise.all([
    fetch(url),
    fetch(refsUrl).catch(() => null)
  ]);
  if (!hypoRes.ok) throw new Error('Failed to load hypotheses');

  const data = await hypoRes.json();
  hypotheses = data.hypotheses ?? [];

  if (refsRes?.ok) adsRefs = await refsRes.json();

  const date = new Date(data.generated_at).toLocaleDateString('en-GB');
  metaEl.textContent = `${data.direction} · ${data.based_on_ads} ads · ${date}`;

  current = 0;
  emptyEl?.remove();
  renderAll();
  return data;
}


// ── History selector ──────────────────────────────────────────────────────────
async function buildHistorySelect() {
  const res = await fetch('data/history-index.json').catch(() => null);
  if (!res?.ok) return;
  const files = await res.json();
  if (!files.length) return;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;gap:6px';

  const label = document.createElement('span');
  label.style.cssText = 'font-size:11px;color:var(--muted)';
  label.textContent = 'History:';

  const sel = document.createElement('select');
  sel.className = 'history-select';
  sel.innerHTML = `<option value="">Latest</option>` +
    files.map(f => {
      const m = f.match(/hypotheses-(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})/);
      const lbl = m ? `${m[1]} ${m[2].replace('-', ':')}` : f;
      return `<option value="data/history/${f}">${lbl}</option>`;
    }).join('');

  sel.addEventListener('change', async () => {
    if (!sel.value) await loadData();
    else await loadData(sel.value, 'data/ads-refs.json');
  });

  wrap.appendChild(label);
  wrap.appendChild(sel);
  document.querySelector('.header-actions').prepend(wrap);
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

function setProgress(pct) {
  progressPct = Math.min(pct, 99);
  btnGenerate.innerHTML = `<span class="btn-spinner"></span>Cooking... ${Math.round(progressPct)}%`;
}

function startProgressAnimation() {
  progressPct = 0;
  // Animate: fast to 40%, slow to 85%, then stall until done
  progressTimer = setInterval(() => {
    if (progressPct < 40)      progressPct += 2.5;
    else if (progressPct < 85) progressPct += 0.4;
    else clearInterval(progressTimer);
    btnGenerate.innerHTML = `<span class="btn-spinner"></span>Cooking... ${Math.round(progressPct)}%`;
  }, 200);
}

function finishProgress() {
  clearInterval(progressTimer);
  btnGenerate.innerHTML = `<span class="btn-spinner"></span>Cooking... 100%`;
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
          document.querySelector('.history-select')?.parentElement?.remove();
          await loadData();
          await buildHistorySelect();
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
    await buildHistorySelect();
  } catch(e) {
    console.error(e);
  }
}

init();
