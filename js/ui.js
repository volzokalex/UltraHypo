// ── i18n ──────────────────────────────────────────────────────────────────────
const i18n = {
  en: {
    based_on:       'Based on',
    all_hypotheses: 'All hypotheses',
    no_data:        'No hypotheses found.',
    hypothesis:     'Hypothesis',
    what_to_test:   'What to test',
    why_it_works:   'Why it works',
    top_hooks:      'Top Hooks',
    top_body:       'Top Body Texts',
    generate:       'Generate Hypotheses',
    reach:          'Reach',
    days:           'Active days',
    active:         'Active',
    inactive:       'Inactive',
  },
  ua: {
    based_on:       'На чому базується',
    all_hypotheses: 'Всі гіпотези',
    no_data:        'Гіпотези не знайдено.',
    hypothesis:     'Гіпотеза',
    what_to_test:   'Що тестуємо',
    why_it_works:   'Чому спрацює',
    top_hooks:      'Топ Хуки',
    top_body:       'Топ Body тексти',
    generate:       'Генерувати гіпотези',
    reach:          'Охоплення',
    days:           'Активних днів',
    active:         'Активний',
    inactive:       'Неактивний',
  }
};

// ── State ─────────────────────────────────────────────────────────────────────
let hypotheses = [];
let adsRefs    = {};
let current    = 0;
let lang       = 'en';

const t = key => i18n[lang][key] ?? key;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const metaEl      = document.getElementById('meta');
const emptyEl     = document.getElementById('empty-state');
const centerEl    = document.getElementById('panel-center');
const refAdsEl    = document.getElementById('ref-ads');
const navPillsEl  = document.getElementById('nav-pills');
const langToggle  = document.getElementById('lang-toggle');
const btnGenerate = document.getElementById('btn-generate');

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtReach = n => n >= 1e6
  ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(n);

const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function fmtBadge(fmt) {
  const cls = `badge-fmt-${(fmt ?? 'image').toLowerCase()}`;
  return `<span class="badge-fmt ${cls}">${fmt ?? 'image'}</span>`;
}

// ── Carousel ──────────────────────────────────────────────────────────────────
function makeCarousel(titleKey, items) {
  if (!items?.length) return '';

  let idx = 0;

  const id = `car-${Math.random().toString(36).slice(2)}`;

  function html() {
    const item = items[idx];
    return `
      <div class="carousel-wrap" id="${id}">
        <div class="carousel-header">
          <div class="carousel-header-left">
            <span class="carousel-title" data-i18n="${titleKey}">${t(titleKey)}</span>
          </div>
        </div>
        <div class="carousel-body">
          <div class="carousel-text ${item.is_dialog ? 'is-dialog' : ''}">${esc(item.text)}</div>
        </div>
        <div class="carousel-footer">
          <div class="carousel-controls">
            <button class="car-prev" ${idx === 0 ? 'disabled' : ''}>←</button>
            <span class="carousel-counter">${fmtBadge(item.format)} ${idx + 1} / ${items.length}</span>
            <button class="car-next" ${idx === items.length - 1 ? 'disabled' : ''}>→</button>
          </div>
          <button class="btn-copy" title="Copy" data-copy="${esc(item.text)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        </div>
      </div>`;
  }

  // We'll wire events after inserting into DOM
  setTimeout(() => wire(id), 0);

  function wire(cid) {
    const el = document.getElementById(cid);
    if (!el) return;

    el.querySelector('.car-prev')?.addEventListener('click', () => {
      if (idx > 0) { idx--; refresh(cid); }
    });
    el.querySelector('.car-next')?.addEventListener('click', () => {
      if (idx < items.length - 1) { idx++; refresh(cid); }
    });
    el.querySelector('.btn-copy')?.addEventListener('click', e => {
      const text = e.currentTarget.dataset.copy;
      navigator.clipboard.writeText(text).catch(() => {});
      e.currentTarget.classList.add('copied');
      setTimeout(() => e.currentTarget.classList.remove('copied'), 1200);
    });
  }

  function refresh(cid) {
    const el = document.getElementById(cid);
    if (!el) return;
    const item = items[idx];
    el.querySelector('.carousel-text').className = `carousel-text${item.is_dialog ? ' is-dialog' : ''}`;
    el.querySelector('.carousel-text').textContent = item.text;
    el.querySelector('.carousel-counter').innerHTML = `${fmtBadge(item.format)} ${idx + 1} / ${items.length}`;
    el.querySelector('.car-prev').disabled = idx === 0;
    el.querySelector('.car-next').disabled = idx === items.length - 1;
    el.querySelector('.btn-copy').dataset.copy = esc(item.text);
  }

  return html();
}

// ── Nav pills ─────────────────────────────────────────────────────────────────
function renderNavPills() {
  navPillsEl.innerHTML = hypotheses.map((h, i) => `
    <button class="nav-pill ${i === current ? 'active' : ''}" data-idx="${i}">
      ${esc(h.title)}
    </button>
  `).join('');

  navPillsEl.querySelectorAll('.nav-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      current = parseInt(btn.dataset.idx);
      renderAll();
    });
  });
}

// ── Ref ads panel ─────────────────────────────────────────────────────────────
function renderRefAds(h) {
  const nums = h.reference_ad_numbers ?? [];
  if (!nums.length) {
    refAdsEl.innerHTML = `<p style="font-size:12px;color:var(--muted)">No references</p>`;
    return;
  }

  refAdsEl.innerHTML = nums.map(num => {
    const ad = adsRefs[num];
    if (!ad) return '';
    const statusCls = ad.status === 'ACTIVE' ? 'active' : 'inactive';
    const statusLabel = ad.status === 'ACTIVE' ? t('active') : t('inactive');
    return `
      <div class="ref-card">
        ${ad.image_url ? `<img src="${esc(ad.image_url)}" alt="Ad ${ad.ad_id}" loading="lazy" />` : ''}
        <div class="ref-card-body">
          <div class="ref-card-stat"><span>${t('reach')}</span><span>${fmtReach(ad.reach)}</span></div>
          <div class="ref-card-stat"><span>${t('days')}</span><span>${ad.active_days}</span></div>
          <span class="ref-status ${statusCls}">${statusLabel}</span>
        </div>
      </div>`;
  }).join('');
}

// ── Main hypothesis render ────────────────────────────────────────────────────
function renderHypothesis() {
  const h = hypotheses[current];
  const priorityClass = h.priority === 'high' ? 'badge-high' : 'badge-medium';
  const priorityLabel = h.priority === 'high' ? '● High' : '● Medium';

  centerEl.innerHTML = `
    <div class="hypo-wrap">
      <div class="badges">
        <span class="badge ${priorityClass}">${priorityLabel}</span>
        <span class="badge badge-format">${h.creative_format ?? 'video'}</span>
      </div>

      <div class="hypo-title">${esc(h.title)}</div>

      <div class="section">
        <div class="section-label" data-i18n="hypothesis">${t('hypothesis')}</div>
        <div class="section-text">${esc(h.hypothesis)}</div>
      </div>

      <div class="section">
        <div class="section-label" data-i18n="what_to_test">${t('what_to_test')}</div>
        <div class="section-text">${esc(h.what_to_test)}</div>
      </div>

      <div class="section">
        <div class="section-label" data-i18n="why_it_works">${t('why_it_works')}</div>
        <div class="section-text">${esc(h.why_it_works)}</div>
      </div>

      ${makeCarousel('top_hooks',  h.top_hooks)}
      ${makeCarousel('top_body',   h.top_body_texts)}
    </div>
  `;
}

// ── Render all panels ─────────────────────────────────────────────────────────
function renderAll() {
  renderHypothesis();
  renderNavPills();
  renderRefAds(hypotheses[current]);
}

// ── Language ──────────────────────────────────────────────────────────────────
function applyLang() {
  langToggle.textContent = lang === 'en' ? 'UA' : 'EN';
  btnGenerate.textContent = `✦ ${t('generate')}`;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
}

langToggle.addEventListener('click', () => {
  lang = lang === 'en' ? 'ua' : 'en';
  applyLang();
  if (hypotheses.length) renderAll();
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [hypoRes, refsRes] = await Promise.all([
      fetch('data/hypotheses.json'),
      fetch('data/ads-refs.json').catch(() => null)
    ]);

    if (!hypoRes.ok) return;
    const data = await hypoRes.json();
    hypotheses = data.hypotheses ?? [];
    if (!hypotheses.length) return;

    if (refsRes?.ok) adsRefs = await refsRes.json();

    const date = new Date(data.generated_at).toLocaleDateString('en-GB');
    metaEl.textContent = `${data.direction} · ${data.based_on_ads} ads · ${date}`;

    emptyEl.remove();
    renderAll();
    applyLang();
  } catch (e) {
    console.error(e);
  }
}

init();
