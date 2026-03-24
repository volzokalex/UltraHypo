import 'dotenv/config';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

const RAW_FILE    = 'data/ads-raw.json';
const SCORED_FILE = 'data/ads-scored.json';
const NICHE_FILE  = 'config/niche.json';

const TEXT_BATCH = 100; // analyze text in batches of 100
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

// ── 4. Текстовий аналіз (батчами) ────────────────────────────────────────────
async function analyzeTextBatch(ads, offset) {
  const list = ads.map((ad, i) =>
    `#${offset + i + 1}: ${clean(ad.Body ?? '—').slice(0, 200)}`
  ).join('\n\n');

  const msg = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `Classify text patterns for ${ads.length} health/fitness Facebook ads (Women 40+, weight loss, Tai Chi, printable plans).

For each ad return its index (1-based, starting from ${offset + 1}) and:
- hook_type: "age_specific"|"ugc_dialog"|"direct_offer"|"pattern_interrupt"|"challenge_date"|"before_after"|"question"
- body_structure: "numbered_list"|"story"|"transformation_timeline"|"bullets"|"simple_offer"|"social_proof"
- cta_type: "get_printable"|"start_challenge"|"take_quiz"|"download"|"buy"|"learn_more"
- emotional_trigger: "fear_aging"|"aspiration_youth"|"identity"|"social_proof"|"urgency"|"authority"

ADS:
${list}

Return ONLY JSON array with exactly ${ads.length} objects:
[{"index":${offset + 1},"hook_type":"...","body_structure":"...","cta_type":"...","emotional_trigger":"..."}]`
    }]
  });

  const match = msg.content[0].text.match(/\[[\s\S]*\]/);
  return match ? JSON.parse(match[0]) : [];
}

async function analyzeAllTextPatterns(ads) {
  const all = [];
  for (let i = 0; i < ads.length; i += TEXT_BATCH) {
    const batch = ads.slice(i, i + TEXT_BATCH);
    console.log(`  text batch ${Math.floor(i / TEXT_BATCH) + 1}/${Math.ceil(ads.length / TEXT_BATCH)} (${i + 1}–${i + batch.length})`);
    const patterns = await analyzeTextBatch(batch, i);
    all.push(...patterns);
  }
  return all;
}

// ── 5. Аналіз зображень (паралельно по 5) ────────────────────────────────────
async function analyzeImage(imageUrl, niche) {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const base64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    const mime   = res.headers.get('content-type') ?? 'image/jpeg';

    const msg = await client.messages.create({
      model:      'claude-opus-4-6',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
          {
            type: 'text',
            text: `Niche: ${niche.direction}. Target audience: Women 40-80, postmenopause, wants to lose weight and feel younger.
Analyze this Facebook ad image. Return JSON only:
{"visual_subject":"what is shown","style":"photo|illustration|ugc|text_heavy","emotion":"dominant emotion","has_text_overlay":true,"text_on_image":"text if visible","fits_niche":true}`
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

  // Text pattern analysis — ALL ads
  console.log(`[1/2] Text pattern analysis for ALL ${enriched.length} ads...`);
  const patterns = await analyzeAllTextPatterns(enriched);
  patterns.forEach(p => {
    const ad = enriched[p.index - 1];
    if (ad) ad._text_pattern = p;
  });
  console.log(`      ✓ ${patterns.length} patterns classified`);

  // Image analysis — ALL image ads, parallel
  await analyzeAllImages(enriched, niche);

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(SCORED_FILE, JSON.stringify(enriched, null, 2));
  console.log(`Saved → ${SCORED_FILE}`);
}

run().catch(err => { console.error(err.message); process.exit(1); });
