import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const API_BASE  = process.env.SPY_TOOL_API?.trim().replace(/\/+$/, '');
const TOKEN     = process.env.SPY_TOOL_TOKEN?.trim().replace(/\s+/g, '');
const OUT_FILE  = path.resolve('data/ads-raw.json');
const PAGE_SIZE = 24;

async function fetchPage(page) {
  const url = `${API_BASE}/ads?sort_by=EU+Total+Reach&sort_order=desc&ranking=top_by_page&page=${page}&limit=${PAGE_SIZE}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
  return res.json();
}

async function fetchAll() {
  console.log('Fetching page 1 to get total count...');
  const first = await fetchPage(1);
  const totalPages = first.pages;
  const allAds = [...first.items];

  console.log(`Total: ${first.total} ads across ${totalPages} pages`);

  for (let p = 2; p <= totalPages; p++) {
    process.stdout.write(`\rFetching page ${p}/${totalPages}...`);
    const data = await fetchPage(p);
    allAds.push(...data.items);
    // small pause to avoid hammering the API
    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`\nDone. Fetched ${allAds.length} ads.`);
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(allAds, null, 2));
  console.log(`Saved → ${OUT_FILE}`);
}

fetchAll().catch(err => {
  console.error('ERR:', err.message);
  console.error('CAUSE:', JSON.stringify(err.cause));
  console.error('API_BASE:', process.env.SPY_TOOL_API?.trim()?.slice(0, 40));
  process.exit(1);
});
