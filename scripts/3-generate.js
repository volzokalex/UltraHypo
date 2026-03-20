import 'dotenv/config';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

const SCORED_FILE = 'data/ads-scored.json';
const NICHE_FILE  = 'config/niche.json';
const OUT_FILE    = 'data/hypotheses.json';
const REFS_FILE   = 'data/ads-refs.json';
const HYPO_COUNT  = 5;

const client = new Anthropic();

const clean = s => s ? s.replace(/[\uD800-\uDFFF]/g, '') : '';

// ── Step 1: hypothesis structures ─────────────────────────────────────────────
function buildStep1Prompt(niche, ads) {
  const adSummaries = ads.map((ad, i) => {
    const img  = ad._image_analysis;
    const type = ad['Asset Type'] === 'image' ? '[IMAGE]' : '[VIDEO]';
    return `AD #${i + 1} ${type} | Score:${Math.round(ad._score)} | Reach:${ad['EU Total Reach']?.toLocaleString()} | Days:${ad['Active days']} | Dupes:${(ad.duplicate_ads ?? []).length} | Domain:${ad.Domain}
Body: ${clean(ad.Body ?? '—').slice(0, 120)}
Image: ${img ? `${clean(img.visual_subject ?? '')}, ${clean(img.emotion ?? '')}` : 'n/a'}`;
  }).join('\n\n');

  return `Performance marketing strategist. Analyze top Facebook ads and generate ${HYPO_COUNT} creative hypotheses.

NICHE: ${niche.direction}
Audience: Women 40-80, USA/Canada, postmenopause
Product: Printable Tai Chi plans, 28-day challenges, 7-10 min/day, no equipment, no jumping
What works: age-specific targeting, printable format, date challenges, anti-running hooks, longevity angle
Avoid: medical claims, intense fitness, men exercises, equipment

TOP ADS:
${adSummaries}

Rules:
- title: in ENGLISH
- hypothesis, what_to_test, based_on, why_it_works: in UKRAINIAN
- reference_ad_numbers: prefer [IMAGE] type ads, pick 2-3 most relevant (1-based index)
- priority: "high" or "medium"
- creative_format: "image" or "video" or "ugc"

Return ONLY a JSON array:
[{"id":1,"title":"English title","hypothesis":"Укр...","what_to_test":"Укр...","based_on":"Укр...","why_it_works":"Укр...","priority":"high","creative_format":"image","reference_ad_numbers":[2,5]}]`;
}

// ── Step 2: hooks, body texts, visual prompt ──────────────────────────────────
function buildStep2Prompt(hypotheses) {
  const list = hypotheses.map(h =>
    `ID ${h.id}: ${h.title} | Format: ${h.creative_format}`
  ).join('\n');

  return `Copywriter for Tai Chi programs. Women 40+, USA/Canada. Printable plans, 7-10 min/day, no equipment.

For each hypothesis below write in ENGLISH only:
- 3 hooks: short punchy opening lines, max 120 chars each
- 3 body texts: formatted with bullet points (• symbol) and line breaks, max 400 chars each
- 1 visual_prompt: detailed AI image/video generation prompt (Midjourney/Sora style), describe: subject, age, setting, mood, style, lighting, camera angle

Hook formats: is_dialog=true → first-person ("I'm 62 and I never thought..."), is_dialog=false → direct statement
Body format example: "Line 1\n• Point one\n• Point two\n• Point three\nCTA line"

${list}

Return ONLY a JSON array with exactly ${hypotheses.length} objects:
[{"id":1,"top_hooks":[{"format":"video","is_dialog":true,"text":"..."},{"format":"image","is_dialog":false,"text":"..."},{"format":"ugc","is_dialog":true,"text":"..."}],"top_body_texts":[{"format":"video","is_dialog":false,"text":"..."},{"format":"image","is_dialog":false,"text":"..."},{"format":"ugc","is_dialog":true,"text":"..."}],"visual_prompt":"Realistic photo of a 63-year-old woman..."}]`;
}

async function callClaude(prompt) {
  const msg = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 8192,
    messages:   [{ role: 'user', content: prompt }]
  });
  const text = msg.content[0].text.trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`No JSON array in response:\n${text.slice(0, 400)}`);
  return JSON.parse(match[0]);
}

async function run() {
  if (!fs.existsSync(SCORED_FILE)) {
    console.error(`Missing ${SCORED_FILE}. Run 2-analyze.js first.`);
    process.exit(1);
  }

  const ads   = JSON.parse(fs.readFileSync(SCORED_FILE, 'utf8'));
  const niche = JSON.parse(fs.readFileSync(NICHE_FILE, 'utf8'));

  console.log(`[1/2] Generating ${HYPO_COUNT} hypothesis structures...`);
  const hypotheses = await callClaude(buildStep1Prompt(niche, ads));
  console.log(`      ✓ ${hypotheses.length} hypotheses`);

  console.log(`[2/2] Generating hooks, body texts & visual prompts...`);
  const creatives = await callClaude(buildStep2Prompt(hypotheses));
  console.log(`      ✓ creatives for ${creatives.length} hypotheses`);

  const creativeMap = Object.fromEntries(creatives.map(c => [c.id, c]));
  const merged = hypotheses.map(h => ({
    ...h,
    top_hooks:      creativeMap[h.id]?.top_hooks      ?? [],
    top_body_texts: creativeMap[h.id]?.top_body_texts ?? [],
    visual_prompt:  creativeMap[h.id]?.visual_prompt  ?? '',
  }));

  // Build ads-refs.json — only image type ads
  const refs = {};
  merged.forEach(h => {
    (h.reference_ad_numbers ?? []).forEach(num => {
      const ad = ads[num - 1];
      if (ad && !refs[num] && ad.Image?.[0]?.url) {
        refs[num] = {
          ad_id:       ad.ID,
          image_url:   ad.Image[0].url,
          reach:       ad['EU Total Reach'] ?? 0,
          active_days: ad['Active days'] ?? 0,
          status:      ad.Status,
          domain:      ad.Domain ?? null,
        };
      }
    });
  });

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    generated_at: new Date().toISOString(),
    direction:    niche.direction,
    based_on_ads: ads.length,
    hypotheses:   merged
  }, null, 2));
  fs.writeFileSync(REFS_FILE, JSON.stringify(refs, null, 2));

  console.log(`Done → ${OUT_FILE}`);
}

run().catch(err => { console.error(err.message); process.exit(1); });
