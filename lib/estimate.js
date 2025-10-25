// lib/estimate.js
import 'dotenv/config';

// Tiny pause to be nice to APIs
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Discogs helpers ---
const DISCOGS_BASE = 'https://api.discogs.com';

async function discogsSearch({ artist, title, catno, barcode }) {
  const q = new URLSearchParams();
  if (artist) q.set('artist', artist);
  if (title)  q.set('release_title', title);
  if (catno)  q.set('catno', catno);
  if (barcode) q.set('barcode', barcode);
  if (![...q.keys()].length) return { results: [] };

  const url = `${DISCOGS_BASE}/database/search?${q.toString()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'vinylzz/1.0 +https://example.com',
      'Authorization': `Discogs token=${process.env.DISCOGS_TOKEN}`
    },
    // Discogs tolerates GET without body
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Discogs search ${res.status}: ${txt}`);
  }
  return res.json();
}

async function discogsReleaseStats(releaseId) {
  if (!releaseId) return null;
  const url = `${DISCOGS_BASE}/marketplace/stats/${releaseId}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'vinylzz/1.0 +https://example.com',
      'Authorization': `Discogs token=${process.env.DISCOGS_TOKEN}`
    }
  });
  if (!res.ok) return null;
  return res.json(); // { num_for_sale, lowest_price, ... }
}

// --- Optional OpenAI assist to clean artist/title (kept minimal) ---
async function aiNormalize(meta) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return meta; // skip if no key
  const sys = "You clean noisy record metadata to {artist, title}. Return strict JSON.";
  const user = `Raw: ${JSON.stringify(meta)}\nOutput keys: artist, title.`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) return meta;
  const data = await res.json();
  try {
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return {
      artist: parsed.artist || meta.artist,
      title:  parsed.title  || meta.title,
      label:  meta.label,
      catno:  meta.catno,
      barcode: meta.barcode
    };
  } catch { return meta; }
}

// --- Core estimator ---
export async function estimateFromMetadata(meta) {
  // (1) Optionally clean fields with AI
  const clean = await aiNormalize(meta);

  // (2) Search Discogs
  await sleep(150); // rate-limit nudge
  const search = await discogsSearch(clean);

  // Pick the top plausible match (simple heuristic)
  const first = search.results?.find(r => r.type === 'release') || search.results?.[0];
  if (!first) {
    return {
      source: 'discogs',
      lowest_price: null,
      median_price: null,
      estimated_price: null,
      extras: { note: 'no results', query: clean, search_count: search.pagination?.items || 0 }
    };
  }

  // (3) Fetch marketplace stats for this release
  await sleep(150);
  const stats = await discogsReleaseStats(first.id);

  const lowest = stats?.lowest_price?.value ?? null;
  // Discogs doesn't expose median in stats endpoint; use a simple derived midpoint if multiple for sale
  const count = stats?.num_for_sale ?? 0;
  const estimated = lowest != null
    ? (count > 5 ? Math.round(lowest * 1.3 * 100) / 100 : lowest) // tiny uplift if market depth
    : null;

  return {
    source: 'discogs',
    lowest_price: lowest,
    median_price: null,             // not provided here; can add additional scraping later
    estimated_price: estimated,
    extras: {
      release_id: first.id,
      title: first.title,
      country: first.country,
      year: first.year,
      label: first.label,
      catno: first.catno,
      community_have: first.community?.have,
      community_want: first.community?.want,
      num_for_sale: stats?.num_for_sale ?? null
    }
  };
}

