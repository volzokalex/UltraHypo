let hypotheses = [];
let current = 0;

const card    = document.getElementById('card');
const counter = document.getElementById('counter');
const meta    = document.getElementById('meta');
const btnNext = document.getElementById('btn-next');

function renderHypothesis(h) {
  const priorityClass = h.priority === 'high' ? 'badge-high' : 'badge-medium';

  card.innerHTML = `
    <div class="badges">
      <span class="badge ${priorityClass}">${h.priority} priority</span>
      <span class="badge badge-format">${h.creative_format}</span>
    </div>

    <div class="hypo-title">${h.title}</div>

    <div class="sections">
      <div>
        <div class="section-label">Гипотеза</div>
        <div class="section-text">${h.hypothesis}</div>
      </div>
      <div>
        <div class="section-label">Что тестируем</div>
        <div class="section-text">${h.what_to_test}</div>
      </div>
      <div>
        <div class="section-label">На чём основана</div>
        <div class="section-text">${h.based_on}</div>
      </div>
      <div>
        <div class="section-label">Почему сработает</div>
        <div class="section-text">${h.why_it_works}</div>
      </div>
      <div class="hook-block">
        <div class="section-label">Suggested hook</div>
        <div class="section-text">${h.suggested_hook}</div>
      </div>
    </div>
  `;

  // Re-trigger animation
  card.style.animation = 'none';
  void card.offsetWidth;
  card.style.animation = '';
}

function showCurrent() {
  renderHypothesis(hypotheses[current]);
  counter.textContent = `${current + 1} / ${hypotheses.length}`;
  btnNext.textContent = current < hypotheses.length - 1 ? 'Next hypothesis →' : 'Start over ↺';
}

btnNext.addEventListener('click', () => {
  current = (current + 1) % hypotheses.length;
  showCurrent();
});

async function init() {
  try {
    const res = await fetch('data/hypotheses.json');
    if (!res.ok) throw new Error('not found');
    const data = await res.json();

    hypotheses = data.hypotheses ?? [];
    if (hypotheses.length === 0) return;

    const date = new Date(data.generated_at).toLocaleDateString('en-GB');
    meta.textContent = `${data.direction} · ${data.based_on_ads} ads · ${date}`;

    btnNext.disabled = false;
    showCurrent();
  } catch {
    // leave the empty state from HTML
  }
}

init();
