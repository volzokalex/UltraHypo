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
    behavior: {}, creative_format: {}, asmr_cues: {}
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
    if (p?.asmr_cues !== undefined) {
      const k = p.asmr_cues ? 'yes' : 'no';
      freq.asmr_cues[k] = (freq.asmr_cues[k] ?? 0) + 1;
    }
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
function buildHypothesisPrompt(niche, ads, patternFreq, pastHypotheses = []) {
  const pastBlock = pastHypotheses.length
    ? `\n## ALREADY GENERATED HYPOTHESES (DO NOT REPEAT THESE ANGLES)\n${pastHypotheses.map(h => `- [${h.creative_format ?? 'image'}] ${h.title}: ${h.what_to_test}`).join('\n')}\n`
    : '';

  return `You are a senior performance marketing strategist. Your task is to generate TRULY UNIQUE creative hypotheses — not copies of what already works, but NEW angles that haven't been tested yet.

## OUR NICHE CONFIG
Direction: ${niche.direction}
Product: ${niche.product_type}
Audience: ${JSON.stringify(niche.audience.pain_points)} | ${JSON.stringify(niche.audience.desires)}
What we avoid: ${JSON.stringify(niche.what_we_avoid)}
Research insights: ${JSON.stringify(niche.research_insights)}

${pastBlock}## WHAT COMPETITORS ARE ALREADY DOING (pattern frequency across top ads)
${Object.entries(patternFreq).map(([cat, vals]) => `${cat}: ${vals.slice(0,4).join(' | ')}`).join('\n')}

## TOP PERFORMING ADS (for reference)
${buildAdContext(ads)}

## YOUR TASK
1. Study the pattern frequencies above — this is what EVERYONE is doing.
2. Find the BLIND SPOTS: angles, formats, emotions, hooks that are ABSENT or underused.
3. Generate ${HYPO_COUNT} hypotheses that test something NEW — not what's already saturated.

IMPORTANT FORMAT SPLIT:
- 3 hypotheses must be "image" format — static ad creative
- 2 hypotheses must be "video" format — short-form video ad concept (Facebook/Reels style, 15-30 sec)

For VIDEO hypotheses: think in terms of the full video mechanic, not just a hook line. Specify:
- HOOK MECHANIC (first 3-7 sec): dialog, ASMR/sensory, pattern interrupt, voiceover over scene
- NARRATIVE ARC: what happens after the hook (problem → aha moment → solution → CTA)
- CHARACTER: is there a person on screen? Speaking? Or just visuals + voiceover?

VIDEO hook mechanics to consider (pick what fits the blind spot):
• Dialog/UGC: character speaks provocative line directly to camera
• ASMR/sensory: no talking, close-up slow movement, satisfying audio cues (rustling paper, soft sounds) — extremely underused in health/fitness
• Text-on-screen + reaction: bold claim appears, character reacts
• Voiceover over scene: narrator speaks while relatable action plays out
• Before/after reveal: visual transformation without heavy editing

ASMR NOTE: ASMR-style content (slow motion, close-ups, ambient sound, no hard sell) is almost absent in this niche but performs strongly for 50+ women who are overwhelmed by aggressive ads. Consider it as a hypothesis angle.

Each hypothesis must:
- Test ONE specific untested angle
- Be grounded in our niche (Tai Chi, women 40+, printable, low-impact)
- Challenge an assumption the market is making
- Have a clear reason WHY this blind spot could be an opportunity

reference_ad_numbers = 1-2 image ads from the list that inspired this hypothesis (1-based index)
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
      ? 'STATIC IMAGE — hooks and body texts are TEXT OVERLAYS on a static image. Hook = bold headline on the image. Body = short formatted text visible on or below the image.'
      : fmt === 'ugc'
      ? 'UGC VIDEO — first-person testimonial, person speaks directly to camera. Hooks = opening spoken line. Body = voiceover script with natural spoken rhythm.'
      : `VIDEO SKETCH — short-form video ad (Facebook/Instagram Reels style).
HOOKS (3-7 sec opening): describe WHAT THE VIEWER SEES + HEARS in the first moment. Can be:
  • Dialog hook: character speaks a provocative line to camera ("My doctor told me to stop…")
  • ASMR/sensory: close-up of slow movement, soft sound cue, no talking
  • Pattern interrupt: unexpected visual that breaks scroll (text on screen + reaction)
  • Voiceover over scene: narrator speaks while action plays
Write each hook as a brief scene direction: "[Visual]: ... [Audio]: ..." or pure dialog.
BODY TEXTS: voiceover SCRIPT for the 15-30 sec after the hook. Written as spoken language, NOT bullet lists. Include natural pauses (/), scene transitions, and a CTA at the end.`;

    return `ID ${h.id} [FORMAT: ${fmt.toUpperCase()}]
${fmtNote}
Title: ${h.title}
Angle: ${h.what_to_test}`;
  }).join('\n\n');

  return `Senior copywriter for Tai Chi health programs. Women 40+, USA/Canada.

CRITICAL: Each format requires completely different writing style.
- IMAGE hooks/body = text overlays, short, scannable
- VIDEO hooks = scene + audio description (what viewer sees AND hears)
- VIDEO body = spoken voiceover script with natural rhythm, NOT bullet points
- UGC = first-person spoken testimonial

For each hypothesis write in ENGLISH:
- 3 hooks: For IMAGE max 130 chars. For VIDEO describe opening scene+audio (2-3 sentences). For UGC max 130 chars spoken line.
- 3 body texts: For IMAGE formatted with line breaks and • bullets, max 380 chars. For VIDEO voiceover script 40-80 words with scene cues. For UGC natural spoken paragraph.
- visual_prompt: Sora/Midjourney-style prompt. For image: static scene. For video: motion, lighting, camera movement, sound mood. For ugc: person description + setting.

is_dialog=true → character speaks (dialog, first-person)
is_dialog=false → narrator voiceover, text overlay, or scene description

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

// ── Збір всіх попередніх гіпотез з архіву ────────────────────────────────────
function loadAllPastHypotheses() {
  const all = [];

  // Current hypotheses.json
  if (fs.existsSync(OUT_FILE)) {
    const cur = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    (cur.hypotheses ?? []).forEach(h => all.push(h));
  }

  // All history files
  const histDir = 'data/history';
  if (fs.existsSync(histDir)) {
    fs.readdirSync(histDir)
      .filter(f => f.startsWith('hypotheses-') && f.endsWith('.json'))
      .forEach(f => {
        try {
          const data = JSON.parse(fs.readFileSync(`${histDir}/${f}`, 'utf8'));
          (data.hypotheses ?? []).forEach(h => all.push(h));
        } catch {}
      });
  }

  // Deduplicate by title
  const seen = new Set();
  return all.filter(h => {
    if (seen.has(h.title)) return false;
    seen.add(h.title);
    return true;
  });
}

async function run() {
  if (!fs.existsSync(SCORED_FILE)) {
    console.error(`Missing ${SCORED_FILE}. Run 2-analyze.js first.`);
    process.exit(1);
  }

  const ads   = JSON.parse(fs.readFileSync(SCORED_FILE, 'utf8'));
  const niche = JSON.parse(fs.readFileSync(NICHE_FILE, 'utf8'));

  // Collect all past hypotheses to avoid repetition
  const pastHypotheses = loadAllPastHypotheses();
  console.log(`Past hypotheses loaded: ${pastHypotheses.length} (will avoid repeating these angles)`);

  // Compute pattern frequencies
  const patternFreq = computePatternFrequency(ads);
  console.log('Pattern frequencies computed.');

  // Step 1: Generate hypotheses from blind spots
  console.log(`[1/2] Generating ${HYPO_COUNT} unique hypotheses from blind spots...`);
  const hypotheses = await callClaude(buildHypothesisPrompt(niche, ads, patternFreq, pastHypotheses));
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
