import 'dotenv/config';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

const RAW_FILE    = 'data/ads-raw.json';
const SCORED_FILE = 'data/ads-scored.json';
const TOP_N       = 30;

const client = new Anthropic();

// Score formula: duplicates carry the most weight (copied = proven),
// then active days (longevity = profitable), then reach (scale)
function scoreAd(ad) {
  const dupes   = (ad.duplicate_ads ?? []).length;
  const days    = ad['Active days'] ?? 0;
  const reach   = ad['EU Total Reach'] ?? 0;
  return dupes * 3000 + days * 100 + reach / 10000;
}

async function analyzeImage(imageUrl) {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';

    const msg = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: contentType, data: base64 }
          },
          {
            type: 'text',
            text: `Analyze this Facebook ad image. Return JSON only:
{
  "visual_subject": "what is shown (person, product, scene)",
  "visual_hook": "the main attention-grabbing element",
  "text_on_image": "any text visible on the image",
  "emotion": "dominant emotion evoked",
  "style": "photo / illustration / ugc / animation / talking_head",
  "color_palette": "dominant colors",
  "cta_visible": "visible CTA if any"
}`
          }
        ]
      }]
    });

    const text = msg.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    console.error(`  Image analysis failed: ${e.message}`);
    return null;
  }
}

async function run() {
  if (!fs.existsSync(RAW_FILE)) {
    console.error(`Missing ${RAW_FILE}. Run 1-fetch.js first.`);
    process.exit(1);
  }

  const ads = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  console.log(`Loaded ${ads.length} ads. Scoring...`);

  const scored = ads
    .map(ad => ({ ...ad, _score: scoreAd(ad) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, TOP_N);

  console.log(`Top ${TOP_N} selected. Analyzing images with Claude Vision...`);

  for (let i = 0; i < scored.length; i++) {
    const ad = scored[i];
    const imageUrl = ad.Image?.[0]?.url;
    process.stdout.write(`\r[${i + 1}/${TOP_N}] Analyzing ad ${ad.ID}...`);

    if (imageUrl) {
      ad._image_analysis = await analyzeImage(imageUrl);
    } else {
      ad._image_analysis = null;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\nDone.');
  fs.writeFileSync(SCORED_FILE, JSON.stringify(scored, null, 2));
  console.log(`Saved → ${SCORED_FILE}`);
}

run().catch(err => { console.error(err); process.exit(1); });
