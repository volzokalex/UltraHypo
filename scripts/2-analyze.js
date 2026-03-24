import 'dotenv/config';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

const RAW_FILE    = 'data/ads-raw.json';
const SCORED_FILE = 'data/ads-scored.json';
const NICHE_FILE  = 'config/niche.json';

const IMG_PARALLEL = 5; // analyze images 5 at a time

const client = new Anthropic();
const clean  = s => s ? s.replace(/[\uD800-\uDFFF]/g, '') : '';

// ── 1. Дедупликація ───────────────────────────────────────────────────────────
function deduplicateAds(ads) {
  const seen = new Set();
  const unique = [];
  for (const ad of ads) {
    if (seen.has(ad.ID)) continue;
    seen.add(ad.ID);
    (ad.duplicate_ads ?? []).forEach(id => seen.add(id));
    unique.push(ad);
  }
  return unique;
}

// ── 2. Тег поведінки ──────────────────────────────────────────────────────────
function tagBehavior(ad) {
  const reach = ad['EU Total Reach'] ?? 0;
  const days  = ad['Active days']    ?? 0;
  if (reach > 500000 && days < 30)  return 'hype';
  if (reach > 150000 && days >= 60) return 'evergreen';
  if (days >= 60)                   return 'slow_burn';
  return 'weak';
}

// ── 3. Скоринг ────────────────────────────────────────────────────────────────
function scoreAd(ad) {
  const reach       = ad['EU Total Reach'] ?? 0;
  const days        = ad['Active days']    ?? 1;
  const activeBoost = ad.Status === 'ACTIVE' ? 1.5 : 1.0;
  return (reach / 1000) * Math.log10(days + 2) * activeBoost;
}

// ── 4. Аналіз картинки + класифікація патернів (один запит) ──────────────────
async function analyzeImage(imageUrl, niche) {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const base64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    const mime   = res.headers.get('content-type') ?? 'image/jpeg';

    const msg = await client.messages.create({
      model:      'claude-opus-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
          {
            type: 'text',
            text: `Niche: ${niche.direction}. Target: Women 40-80, postmenopause, weight loss, Tai Chi.

Analyze this Facebook ad image. The most important text is what's ON the image itself (hook, body, CTA).

Return JSON only:
{
  "visual_subject": "what is shown",
  "style": "photo|illustration|ugc|text_heavy",
  "emotion": "dominant emotion conveyed",
  "text_on_image": "all text visible on the image",
  "hook_type": "age_specific|ugc_dialog|direct_offer|pattern_interrupt|challenge_date|before_after|question|none",
  "body_structure": "numbered_list|story|transformation_timeline|bullets|simple_offer|social_proof|none",
  "cta_type": "get_printable|start_challenge|take_quiz|download|buy|learn_more|none",
  "emotional_trigger": "fear_aging|aspiration_youth|identity|social_proof|urgency|authority|none",
  "fits_niche": true
}`
          }
        ]
      }]
    });

    const match = msg.content[0].text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

async function analyzeAllImages(ads, niche) {
  const imageAds = ads.filter(ad => ad.Image?.[0]?.url);
  console.log(`[2/2] Image analysis for ${imageAds.length} image ads (${IMG_PARALLEL} parallel)...`);

  let done = 0;
  for (let i = 0; i < imageAds.length; i += IMG_PARALLEL) {
    const batch = imageAds.slice(i, i + IMG_PARALLEL);
    await Promise.all(batch.map(async ad => {
      ad._image_analysis = await analyzeImage(ad.Image[0].url, niche);
      done++;
      process.stdout.write(`\r  [${done}/${imageAds.length}]`);
    }));
    if (i + IMG_PARALLEL < imageAds.length) {
      await new Promise(r => setTimeout(r, 1000)); // rate limit between batches
    }
  }
  console.log('\n      ✓ Done');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!fs.existsSync(RAW_FILE)) {
    console.error(`Missing ${RAW_FILE}. Run 1-fetch.js first.`);
    process.exit(1);
  }

  const rawAds = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const niche  = JSON.parse(fs.readFileSync(NICHE_FILE, 'utf8'));

  // Deduplicate
  const unique = deduplicateAds(rawAds);
  console.log(`Deduplicated: ${rawAds.length} → ${unique.length} unique ads`);

  // Tag + score + sort
  const enriched = unique
    .map(ad => ({ ...ad, _behavior: tagBehavior(ad), _score: scoreAd(ad) }))
    .sort((a, b) => b._score - a._score);

  // Stats
  const behaviors = enriched.reduce((acc, ad) => {
    acc[ad._behavior] = (acc[ad._behavior] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Behavior breakdown:`, behaviors);

  // Image analysis — ALL ads with images, parallel
  // Patterns (hook_type, body_structure etc.) extracted from image text, not Body field
  await analyzeAllImages(enriched, niche);

  // Copy image analysis patterns into _text_pattern for compatibility with 3-generate.js
  enriched.forEach(ad => {
    if (ad._image_analysis) {
      ad._text_pattern = {
        hook_type:        ad._image_analysis.hook_type,
        body_structure:   ad._image_analysis.body_structure,
        cta_type:         ad._image_analysis.cta_type,
        emotional_trigger: ad._image_analysis.emotional_trigger,
      };
    }
  });

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(SCORED_FILE, JSON.stringify(enriched, null, 2));
  console.log(`Saved → ${SCORED_FILE}`);
}

run().catch(err => { console.error(err.message); process.exit(1); });
