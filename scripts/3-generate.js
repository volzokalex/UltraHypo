import 'dotenv/config';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

const SCORED_FILE = 'data/ads-scored.json';
const NICHE_FILE  = 'config/niche.json';
const OUT_FILE    = 'data/hypotheses.json';
const REFS_FILE   = 'data/ads-refs.json';
const HYPO_COUNT  = 5;

const client = new Anthropic();
const clean  = s => s ? s.replace(/[\uD800-\uDFFF]/g, '') : '';

// ── Підрахунок частоти паттернів ──────────────────────────────────────────────
function computePatternFrequency(ads) {
  const freq = {
    hook_type: {}, body_structure: {}, cta_type: {}, emotional_trigger: {},
    behavior: {}, creative_format: {}
  };

  ads.forEach(ad => {
    const p = ad._text_pattern;
    if (p) {
      ['hook_type','body_structure','cta_type','emotional_trigger'].forEach(key => {
        if (p[key]) freq[key][p[key]] = (freq[key][p[key]] ?? 0) + 1;
      });
    }
    if (ad._behavior) freq.behavior[ad._behavior] = (freq.behavior[ad._behavior] ?? 0) + 1;
    if (ad['Asset Type']) freq.creative_format[ad['Asset Type']] = (freq.creative_format[ad['Asset Type']] ?? 0) + 1;
  });

  // Convert to sorted percentages
  return Object.fromEntries(
    Object.entries(freq).map(([cat, counts]) => {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const sorted = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}: ${Math.round(v / total * 100)}%`);
      return [cat, sorted];
    })
  );
}

// ── Топ-оголошення для контексту ──────────────────────────────────────────────
function buildAdContext(ads) {
  return ads.slice(0, 20).map((ad, i) => {
    const img = ad._image_analysis;
    const p   = ad._text_pattern;
    return `AD #${i + 1} [${ad._behavior?.toUpperCase()}] | Reach: ${ad['EU Total Reach']?.toLocaleString()} | Days: ${ad['Active days']} | Status: ${ad.Status}
Body: ${clean(ad.Body ?? '—').slice(0, 180)}
Pattern: hook=${p?.hook_type ?? '?'} | body=${p?.body_structure ?? '?'} | trigger=${p?.emotional_trigger ?? '?'}
Visual: ${img ? `${img.visual_subject ?? ''}, style=${img.style ?? '?'}, emotion=${img.emotion ?? '?'}` : 'n/a'}`;
  }).join('\n\n');
}

// ── Промт для генерації гіпотез (пошук сліпих зон) ───────────────────────────
function buildHypothesisPrompt(niche, ads, patternFreq) {
  return `You are a senior performance marketing strategist. Your task is to generate TRULY UNIQUE creative hypotheses — not copies of what already works, but NEW angles that haven't been tested yet.

## OUR NICHE CONFIG
Direction: ${niche.direction}
Product: ${niche.product_type}
Audience: ${JSON.stringify(niche.audience.pain_points)} | ${JSON.stringify(niche.audience.desires)}
What we avoid: ${JSON.stringify(niche.what_we_avoid)}
Research insights: ${JSON.stringify(niche.research_insights)}

## WHAT COMPETITORS ARE ALREADY DOING (pattern frequency across top ads)
${Object.entries(patternFreq).map(([cat, vals]) => `${cat}: ${vals.slice(0,4).join(' | ')}`).join('\n')}

## TOP PERFORMING ADS (for reference)
${buildAdContext(ads)}

## YOUR TASK
1. Study the pattern frequencies above — this is what EVERYONE is doing.
2. Find the BLIND SPOTS: angles, formats, emotions, hooks that are ABSENT or underused.
3. Generate ${HYPO_COUNT} hypotheses that test something NEW — not what's already saturated.

Each hypothesis must:
- Test ONE specific untested angle
- Be grounded in our niche (Tai Chi, women 40+, printable, low-impact)
- Challenge an assumption the market is making
- Have a clear reason WHY this blind spot could be an opportunity

reference_ad_numbers = 1-2 ads from the list that inspired this hypothesis (1-based index, IMAGE type preferred)
title: in English
hypothesis, what_to_test, based_on, why_it_works: in Ukrainian

Return ONLY a JSON array:
[{"id":1,"title":"English title","hypothesis":"Укр...","what_to_test":"Укр...","based_on":"Укр...","why_it_works":"Укр...","priority":"high","creative_format":"image","reference_ad_numbers":[3]}]`;
}

// ── Промт для хуків, боді, візуального промту ─────────────────────────────────
// Всі хуки, боді та visual_prompt відповідають формату гіпотези (image / video / ugc)
function buildCreativesPrompt(hypotheses) {
  const list = hypotheses.map(h => {
    const fmt = h.creative_format ?? 'image';
    const fmtNote = fmt === 'image'
      ? 'STATIC IMAGE creative — all hooks and body texts are for a static ad (text overlay, visual message, no motion)'
      : fmt === 'ugc'
      ? 'UGC VIDEO creative — first-person testimonial style, spoken to camera'
      : 'VIDEO creative — motion, voiceover or text animation';

    return `ID ${h.id} [FORMAT: ${fmt.toUpperCase()}]
${fmtNote}
Title: ${h.title}
Angle: ${h.what_to_test}`;
  }).join('\n\n');

  return `Senior copywriter for Tai Chi health programs. Women 40+, USA/Canada.

IMPORTANT: Each hypothesis has a specific creative format. ALL hooks, body texts and visual_prompt must match that format exactly. Do NOT mix formats.

For each hypothesis write in ENGLISH:
- 3 hooks: max 130 chars. All 3 must match the hypothesis format.
- 3 body texts: formatted with line breaks and • bullets, max 380 chars. All 3 must match the format.
- visual_prompt: Midjourney/Sora-style prompt matching the format. For image: describe a static scene. For video: describe motion, sequence, camera movement. For ugc: describe a person speaking to camera.

is_dialog=true → first-person ("I'm 58 and I never thought...")
is_dialog=false → direct statement or pattern interrupt

${list}

Return ONLY JSON array with exactly ${hypotheses.length} objects:
[{"id":1,"top_hooks":[{"format":"image","is_dialog":false,"text":"..."},{"format":"image","is_dialog":true,"text":"..."},{"format":"image","is_dialog":false,"text":"..."}],"top_body_texts":[{"format":"image","is_dialog":false,"text":"..."},{"format":"image","is_dialog":false,"text":"..."},{"format":"image","is_dialog":true,"text":"..."}],"visual_prompt":"..."}]`;
}

async function callClaude(prompt) {
  const msg = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 8192,
    messages:   [{ role: 'user', content: prompt }]
  });
  const text  = msg.content[0].text.trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`No JSON in response:\n${text.slice(0, 400)}`);
  return JSON.parse(match[0]);
}

async function run() {
  if (!fs.existsSync(SCORED_FILE)) {
    console.error(`Missing ${SCORED_FILE}. Run 2-analyze.js first.`);
    process.exit(1);
  }

  const ads   = JSON.parse(fs.readFileSync(SCORED_FILE, 'utf8'));
  const niche = JSON.parse(fs.readFileSync(NICHE_FILE, 'utf8'));

  // Compute pattern frequencies
  const patternFreq = computePatternFrequency(ads);
  console.log('Pattern frequencies computed.');

  // Step 1: Generate hypotheses from blind spots
  console.log(`[1/2] Generating ${HYPO_COUNT} unique hypotheses from blind spots...`);
  const hypotheses = await callClaude(buildHypothesisPrompt(niche, ads, patternFreq));
  console.log(`      ✓ ${hypotheses.length} hypotheses`);

  // Step 2: Generate hooks, body texts, visual prompts
  console.log(`[2/2] Generating hooks, body texts & visual prompts...`);
  const creatives = await callClaude(buildCreativesPrompt(hypotheses));
  console.log(`      ✓ creatives for ${creatives.length} hypotheses`);

  // Merge
  const creativeMap = Object.fromEntries(creatives.map(c => [c.id, c]));
  const merged = hypotheses.map(h => ({
    ...h,
    top_hooks:      creativeMap[h.id]?.top_hooks      ?? [],
    top_body_texts: creativeMap[h.id]?.top_body_texts ?? [],
    visual_prompt:  creativeMap[h.id]?.visual_prompt  ?? '',
  }));

  // Build ads-refs (image ads only)
  const refs = {};
  merged.forEach(h => {
    (h.reference_ad_numbers ?? []).forEach(num => {
      const ad = ads[num - 1];
      if (ad && !refs[num] && ad.Image?.[0]?.url) {
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
  });

  fs.mkdirSync('data', { recursive: true });
  fs.mkdirSync('data/history', { recursive: true });

  const payload = {
    generated_at: new Date().toISOString(),
    direction:    niche.direction,
    based_on_ads: ads.length,
    pattern_freq: patternFreq,
    hypotheses:   merged
  };

  // Archive previous hypotheses before overwriting
  if (fs.existsSync(OUT_FILE)) {
    const prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    if (prev.generated_at) {
      const stamp = prev.generated_at.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      fs.writeFileSync(`data/history/hypotheses-${stamp}.json`, JSON.stringify(prev, null, 2));
      console.log(`Archived previous → data/history/hypotheses-${stamp}.json`);
    }
  }

  // Update history index
  const historyFiles = fs.readdirSync('data/history')
    .filter(f => f.startsWith('hypotheses-') && f.endsWith('.json'))
    .sort().reverse();
  fs.writeFileSync('data/history-index.json', JSON.stringify(historyFiles, null, 2));

  fs.writeFileSync(OUT_FILE,  JSON.stringify(payload, null, 2));
  fs.writeFileSync(REFS_FILE, JSON.stringify(refs, null, 2));

  console.log(`Done → ${OUT_FILE}`);
}

run().catch(err => { console.error(err.message); process.exit(1); });
