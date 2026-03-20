// ── i18n (только лейблы интерфейса) ──────────────────────────────────────────
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
    visual_prompt:  'Visual Prompt',
    generate:       '✦ Generate Hypotheses',
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
    visual_prompt:  'Візуальний промт',
    generate:       '✦ Генерувати гіпотези',
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

// ── DOM ───────────────────────────────────────────────────────────────────────
const metaEl      = document.getElementById('meta');
const emptyEl     = document.getElementById('empty-state');
const centerEl    = document.getElementById('panel-center');
const refAdsEl    = document.getElementById('ref-ads');
const navPillsEl  = document.getElementById('nav-pills');
const langToggle  = document.getElementById('lang-toggle');
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
        <span class="carousel-title">${t(titleKey)}</span>
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
  navPillsEl.innerHTML = hypotheses.map((h, i) => `
    <button class="nav-pill${i===current?' active':''}" data-idx="${i}">${esc(h.title)}</button>
  `).join('');
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
        <div class="ref-card-stat"><span>${t('reach')}</span><span>${fmtReach(ad.reach)}</span></div>
        <div class="ref-card-stat"><span>${t('days')}</span><span>${ad.active_days}</span></div>
        <span class="ref-status ${statusCls}">${ad.status === 'ACTIVE' ? t('active') : t('inactive')}</span>
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

  const visualBlock = h.visual_prompt ? `
    <div class="visual-prompt-block">
      <div class="section-label">${t('visual_prompt')}</div>
      <div class="visual-prompt-text">${esc(h.visual_prompt)}</div>
      <div class="visual-prompt-footer">${copyBtn(h.visual_prompt)}</div>
    </div>` : '';

  centerEl.innerHTML = `
    <div class="hypo-wrap">
      <div class="badges">
        <span class="badge ${priorityClass}">● ${h.priority}</span>
        <span class="badge badge-format">${esc(h.creative_format ?? 'image')}</span>
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

      ${makeCarousel('top_hooks', h.top_hooks)}
      ${makeCarousel('top_body',  h.top_body_texts)}
      ${visualBlock}
    </div>`;

  wireCopyButtons(centerEl);
}

// ── Render all ────────────────────────────────────────────────────────────────
function renderAll() {
  renderHypothesis();
  renderNavPills();
  renderRefAds(hypotheses[current]);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Language toggle ───────────────────────────────────────────────────────────
langToggle.addEventListener('click', () => {
  lang = lang === 'en' ? 'ua' : 'en';
  langToggle.textContent = lang === 'en' ? 'UA' : 'EN';
  btnGenerate.textContent = t('generate');
  if (hypotheses.length) renderAll();
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

    emptyEl?.remove();
    renderAll();
  } catch(e) {
    console.error(e);
  }
}

init();
