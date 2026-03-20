import 'dotenv/config';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

const SCORED_FILE = 'data/ads-scored.json';
const NICHE_FILE  = 'config/niche.json';
const OUT_FILE    = 'data/hypotheses.json';
const HYPO_COUNT  = 10;

const client = new Anthropic();

function buildPrompt(niche, ads) {
  const adSummaries = ads.map((ad, i) => {
    const img = ad._image_analysis;
    return `
AD #${i + 1}
- Score: ${Math.round(ad._score)} | Reach: ${ad['EU Total Reach']?.toLocaleString()} | Days: ${ad['Active days']} | Dupes: ${(ad.duplicate_ads ?? []).length}
- Status: ${ad.Status} | Platform: ${(ad.Platform ?? []).join(', ')}
- Domain: ${ad.Domain}
- Body: ${ad.Body ?? '—'}
- Image analysis: ${img ? JSON.stringify(img) : 'not available'}
`.trim();
  }).join('\n\n');

  return `You are a performance marketing strategist specializing in direct response advertising.

## OUR NICHE
Direction: ${niche.direction}
Product type: ${niche.product_type || 'not specified'}
Audience: ${JSON.stringify(niche.audience, null, 2)}
Key messages: ${JSON.stringify(niche.key_messages)}
Hooks that work: ${JSON.stringify(niche.hooks_that_work)}
CTA patterns: ${JSON.stringify(niche.cta_patterns)}
Visual patterns: ${JSON.stringify(niche.visual_patterns)}
What we avoid: ${JSON.stringify(niche.what_we_avoid)}
Research insights: ${JSON.stringify(niche.research_insights)}

## TOP PERFORMING ADS IN THIS SPACE
${adSummaries}

## YOUR TASK
Analyze the top ads above. Find patterns in:
- Visual styles that dominate (ugc vs polished, colors, subjects)
- Body/hook structures that repeat in high-performing ads
- What emotional triggers they use
- What makes certain creatives get duplicated many times (social proof = it's working)

Then generate ${HYPO_COUNT} CREATIVE HYPOTHESES for our ${niche.direction} direction.

Each hypothesis must:
1. Be NEW — not copy existing creatives, but learn from their patterns
2. Stay within our niche direction and audience
3. Test ONE specific variable (visual, hook, emotion, format, CTA)
4. Have a clear rationale based on the data

IMPORTANT: Write ALL text fields (title, hypothesis, what_to_test, based_on, why_it_works, suggested_hook) in Ukrainian language.

Return a JSON array only:
[
  {
    "id": 1,
    "title": "Short catchy title of the hypothesis",
    "hypothesis": "Clear one-sentence statement of what we believe",
    "what_to_test": "Specific creative element or angle to test",
    "based_on": "Specific patterns/data points from the analyzed ads",
    "why_it_works": "Psychological or behavioral reason this could outperform",
    "priority": "high / medium",
    "creative_format": "video / image / ugc / carousel",
    "suggested_hook": "Example opening line or visual concept"
  }
]`;
}

async function run() {
  if (!fs.existsSync(SCORED_FILE)) {
    console.error(`Missing ${SCORED_FILE}. Run 2-analyze.js first.`);
    process.exit(1);
  }

  const ads   = JSON.parse(fs.readFileSync(SCORED_FILE, 'utf8'));
  const niche = JSON.parse(fs.readFileSync(NICHE_FILE, 'utf8'));

  console.log(`Generating ${HYPO_COUNT} hypotheses for "${niche.direction}"...`);

  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: buildPrompt(niche, ads)
    }]
  });

  const text = msg.content[0].text.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error('Could not parse JSON from response:', text);
    process.exit(1);
  }

  const hypotheses = JSON.parse(jsonMatch[0]);
  const output = {
    generated_at: new Date().toISOString(),
    direction: niche.direction,
    based_on_ads: ads.length,
    hypotheses
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Done. ${hypotheses.length} hypotheses saved → ${OUT_FILE}`);
}

run().catch(err => { console.error(err); process.exit(1); });
