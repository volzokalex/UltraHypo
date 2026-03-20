import 'dotenv/config';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

const SCORED_FILE = 'data/ads-scored.json';
const NICHE_FILE  = 'config/niche.json';
const OUT_FILE    = 'data/hypotheses.json';
const REFS_FILE   = 'data/ads-refs.json';
const HYPO_COUNT  = 5;

const client = new Anthropic();

// Remove lone surrogates and other problematic unicode that breaks JSON
const clean = s => s ? s.replace(/[\uD800-\uDFFF]/g, '') : '';

// ── Запит 1: структура гіпотез (без хуків і боді) ────────────────────────────
function buildStep1Prompt(niche, ads) {
  const adSummaries = ads.map((ad, i) => {
    const img = ad._image_analysis;
    return `AD #${i + 1} | Score:${Math.round(ad._score)} | Reach:${ad['EU Total Reach']?.toLocaleString()} | Days:${ad['Active days']} | Dupes:${(ad.duplicate_ads ?? []).length} | Domain:${ad.Domain}
Body: ${clean(ad.Body ?? '—').slice(0, 150)}
Image: ${img ? `${clean(img.visual_subject ?? '')}, ${clean(img.emotion ?? '')}` : 'n/a'}`;
  }).join('\n\n');

  return `Performance marketing strategist. Analyze top Facebook ads and generate ${HYPO_COUNT} creative hypotheses.

NICHE: ${niche.direction}
Audience: Women 40-80, USA/Canada, postmenopause, wants to lose weight, feel younger, stay active
Product: Printable Tai Chi plans, 28-day challenges, 7-10 min/day, no equipment, no jumping
What works: age-specific targeting, printable format, date challenges, anti-running hooks, longevity angle
Avoid: medical claims, intense fitness, men's exercises, equipment

TOP ADS:
${adSummaries}

Generate ${HYPO_COUNT} hypotheses. ALL text in Ukrainian.
reference_ad_numbers = 1-based indexes of 2-3 most relevant ads from the list above.

Return ONLY a JSON array, no other text:
[{"id":1,"title":"...","hypothesis":"...","what_to_test":"...","based_on":"...","why_it_works":"...","priority":"high","creative_format":"video","reference_ad_numbers":[3,7]}]`;
}

// ── Запит 2: хуки і боді тексти для кожної гіпотези ──────────────────────────
function buildStep2Prompt(hypotheses) {
  const list = hypotheses.map(h =>
    `ID ${h.id}: ${h.title}\nГіпотеза: ${h.hypothesis}\nФормат: ${h.creative_format}`
  ).join('\n\n');

  return `Copywriter for Tai Chi programs for women 40+. Printable plans, 7-10 min/day, no equipment.
Working hooks: age-specific ("TO MY LADIES OVER 60"), anti-running, longevity, UGC "I am [age]".

For each hypothesis write 3 hooks and 3 body texts in Ukrainian.
is_dialog=true → first-person ("Мені 62 роки, і я...")
is_dialog=false → direct offer or statement

${list}

Return ONLY a JSON array with exactly ${hypotheses.length} objects, no other text:
[{"id":1,"top_hooks":[{"format":"video","is_dialog":true,"text":"..."},{"format":"image","is_dialog":false,"text":"..."},{"format":"ugc","is_dialog":true,"text":"..."}],"top_body_texts":[{"format":"video","is_dialog":false,"text":"..."},{"format":"image","is_dialog":false,"text":"..."},{"format":"ugc","is_dialog":true,"text":"..."}]}]`;
}

async function callClaude(prompt) {
  const msg = await client.messages.create({
    model:    'claude-opus-4-6',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }]
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

  console.log(`[2/2] Generating hooks & body texts...`);
  const creatives = await callClaude(buildStep2Prompt(hypotheses));
  console.log(`      ✓ creatives for ${creatives.length} hypotheses`);

  // Merge
  const creativeMap = Object.fromEntries(creatives.map(c => [c.id, c]));
  const merged = hypotheses.map(h => ({
    ...h,
    top_hooks:      creativeMap[h.id]?.top_hooks      ?? [],
    top_body_texts: creativeMap[h.id]?.top_body_texts ?? [],
  }));

  // Build ads-refs.json
  const refs = {};
  merged.forEach(h => {
    (h.reference_ad_numbers ?? []).forEach(num => {
      const ad = ads[num - 1];
      if (ad && !refs[num]) {
        refs[num] = {
          ad_id:       ad.ID,
          image_url:   ad.Image?.[0]?.url ?? null,
          reach:       ad['EU Total Reach'] ?? 0,
          active_days: ad['Active days'] ?? 0,
          status:      ad.Status,
          domain:      ad.Domain ?? null,
        };
      }
    });
  });

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT_FILE,  JSON.stringify({ generated_at: new Date().toISOString(), direction: niche.direction, based_on_ads: ads.length, hypotheses: merged }, null, 2));
  fs.writeFileSync(REFS_FILE, JSON.stringify(refs, null, 2));

  console.log(`Done → ${OUT_FILE}`);
}

run().catch(err => { console.error(err.message); process.exit(1); });
