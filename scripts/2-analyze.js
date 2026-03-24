import 'dotenv/config';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { pool, initSchema } from '../db.js';

const RAW_FILE  = 'data/ads-raw.json';
const NICHE_FILE = 'config/niche.json';

const IMG_PARALLEL = 5;

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

// ── 4. Аналіз картинки ────────────────────────────────────────────────────────
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
  "hook_type": "age_specific|ugc_dialog|direct_offer|pattern_interrupt|challenge_date|before_after|question|asmr_sensory|none",
  "body_structure": "numbered_list|story|transformation_timeline|bullets|simple_offer|social_proof|voiceover_script|none",
  "cta_type": "get_printable|start_challenge|take_quiz|download|buy|learn_more|none",
  "emotional_trigger": "fear_aging|aspiration_youth|identity|social_proof|urgency|authority|sensory_calm|none",
  "asmr_cues": false,
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

async function analyzeAllImages(ads, niche, dbCache) {
  const imageAds = ads.filter(ad => ad.Image?.[0]?.url && !dbCache[ad.ID]);
  const cached   = ads.filter(ad => ad.Image?.[0]?.url &&  dbCache[ad.ID]).length;
  if (cached) console.log(`  Skipping ${cached} already-analyzed ads (from DB)`);
  if (!imageAds.length) { console.log('  All ads already analyzed, skipping.'); return; }
  console.log(`[2/2] Image analysis for ${imageAds.length} new ads (${IMG_PARALLEL} parallel)...`);

  let done = 0;
  for (let i = 0; i < imageAds.length; i += IMG_PARALLEL) {
    const batch = imageAds.slice(i, i + IMG_PARALLEL);
    await Promise.all(batch.map(async ad => {
      const analysis = await analyzeImage(ad.Image[0].url, niche);
      if (analysis) {
        ad._image_analysis = analysis;
        // Upsert into DB immediately so progress is saved
        await pool.query(
          `INSERT INTO ads_analysis (ad_id, data) VALUES ($1, $2)
           ON CONFLICT (ad_id) DO UPDATE SET data = $2, analyzed_at = NOW()`,
          [ad.ID, JSON.stringify({ ...ad, _image_analysis: analysis })]
        );
      }
      done++;
      process.stdout.write(`\r  [${done}/${imageAds.length}]`);
    }));
    if (i + IMG_PARALLEL < imageAds.length) {
      await new Promise(r => setTimeout(r, 1000));
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

  await initSchema();

  const rawAds = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const niche  = JSON.parse(fs.readFileSync(NICHE_FILE, 'utf8'));

  // Load existing analysis from DB
  const dbRows = await pool.query('SELECT ad_id, data FROM ads_analysis');
  const dbCache = Object.fromEntries(dbRows.rows.map(r => [r.ad_id, r.data]));
  console.log(`DB cache: ${dbRows.rows.length} previously analyzed ads`);

  // Deduplicate
  const unique = deduplicateAds(rawAds);
  console.log(`Deduplicated: ${rawAds.length} → ${unique.length} unique ads`);

  // Tag + score + sort, restore analysis from DB
  const enriched = unique
    .map(ad => {
      const cached = dbCache[ad.ID];
      return {
        ...ad,
        _behavior:       tagBehavior(ad),
        _score:          scoreAd(ad),
        _image_analysis: cached?._image_analysis ?? undefined,
        _text_pattern:   cached?._text_pattern   ?? undefined,
      };
    })
    .sort((a, b) => b._score - a._score);

  const behaviors = enriched.reduce((acc, ad) => {
    acc[ad._behavior] = (acc[ad._behavior] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Behavior breakdown:`, behaviors);

  // Analyze new images
  await analyzeAllImages(enriched, niche, dbCache);

  // Copy image analysis into _text_pattern
  enriched.forEach(ad => {
    if (ad._image_analysis && !ad._text_pattern) {
      ad._text_pattern = {
        hook_type:         ad._image_analysis.hook_type,
        body_structure:    ad._image_analysis.body_structure,
        cta_type:          ad._image_analysis.cta_type,
        emotional_trigger: ad._image_analysis.emotional_trigger,
        asmr_cues:         ad._image_analysis.asmr_cues ?? false,
      };
      // Update DB with text_pattern
      pool.query(
        `UPDATE ads_analysis SET data = data || $1 WHERE ad_id = $2`,
        [JSON.stringify({ _text_pattern: ad._text_pattern }), ad.ID]
      ).catch(() => {});
    }
  });

  // Save local backup
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/ads-scored.json', JSON.stringify(enriched, null, 2));
  console.log(`Saved local backup → data/ads-scored.json`);
  console.log(`DB updated with ${enriched.filter(a => a._image_analysis).length} analyzed ads`);

  await pool.end();
}

run().catch(err => { console.error(err.message); process.exit(1); });
