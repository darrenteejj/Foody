// Pulls the live CDC Vouchers merchant list from CDC Go Where, keeps only
// restaurants and cafés in Foody's five areas, and drops any address shared
// by several stalls (hawker centres, food courts, coffeeshops).
const zlib = require('zlib');

const SOURCE = 'https://prd-tmp.cdn.gowhere.gov.sg/cdcvouchersgowhere/data.gzip';

// Areas are matched by the first two digits of the postal code (postal sector).
const AREAS = [
  { id: 'tiong-bahru', name: 'Tiong Bahru', sectors: ['16'] },
  { id: 'east-coast', name: 'East Coast', sectors: ['42', '43', '44', '45'] },
  { id: 'woodlands', name: 'Woodlands', sectors: ['73'] },
  { id: 'jurong', name: 'Jurong', sectors: ['60', '61', '62', '63', '64'] },
  { id: 'changi', name: 'Changi', sectors: ['48', '49', '50'] },
];

// An address with this many or more CDC merchants is treated as a shared
// stall location and removed entirely.
const SHARED_LIMIT = Number(process.env.SHARED_LIMIT || 3);

const FOOD_WORDS = /(f\s*&\s*b|food|beverage|restaurant|caf[eé]|coffee|bakery|dessert|eat|dining|bistro|kitchen|drink|tea\b)/i;
const NON_FOOD_WORDS = /(supermarket|grocer|provision|minimart|mini mart|pharmacy|hardware|salon|barber|laundry|tailor|optical|clinic|florist|stationery|electrical|handphone|mobile|tuition)/i;
const STALL_PLACE = /(hawker|food\s*cent(re|er)|market|food\s*court|foodcourt|coffee\s*shop|coffeeshop|kopitiam|eating\s*house|canteen)/i;

let cache = { at: 0, data: null };

const pick = (o, re) => {
  for (const k of Object.keys(o)) if (re.test(k) && o[k] != null && o[k] !== '') return o[k];
  return undefined;
};

function flatten(o, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(o || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function findRecords(j) {
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object') {
    for (const v of Object.values(j)) {
      const r = findRecords(v);
      if (r && r.length && typeof r[0] === 'object') return r;
    }
  }
  return null;
}

function normalise(raw) {
  const f = flatten(raw);
  const name = pick(f, /(^|\.)(name|merchant_?name|shop_?name|business_?name|title)$/i);
  const address = pick(f, /(^|\.)(address|full_?address|addr|street)$/i) || pick(f, /address/i);
  let postal = pick(f, /postal|postcode|zip/i);
  const text = [address, postal].filter(Boolean).join(' ');
  if (!postal) {
    const m = /\b(\d{6})\b/.exec(text);
    postal = m && m[1];
  }
  postal = postal ? String(postal).replace(/\D/g, '').padStart(6, '0').slice(-6) : '';
  const lat = Number(pick(f, /(^|\.)(lat|latitude)$/i));
  const lng = Number(pick(f, /(^|\.)(lng|lon|long|longitude)$/i));
  const category = [pick(f, /categor|type|class|segment|industry|tag/i)].flat().filter(Boolean).join(', ');
  const unit = pick(f, /unit|level/i);
  return {
    name: name ? String(name).trim() : '',
    address: address ? String(address).trim() : '',
    unit: unit ? String(unit).trim() : '',
    postal,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    category: String(category || ''),
  };
}

// Same building = same postal code; fall back to the street address with the
// unit number stripped when a record has no postal code.
function placeKey(m) {
  if (m.postal) return m.postal;
  return m.address.toLowerCase().replace(/#\s*[\w-]+/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function load() {
  const r = await fetch(`${SOURCE}?v=${Math.floor(Date.now() / 36e5)}`, {
    headers: {
      Referer: 'https://www.gowhere.gov.sg/',
      Origin: 'https://www.gowhere.gov.sg',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      Accept: 'application/json, text/plain, */*',
    },
  });
  if (!r.ok) throw new Error(`CDC Go Where answered ${r.status}`);
  let buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const json = JSON.parse(buf.toString('utf8'));
  const records = findRecords(json) || [];
  const all = records.map(normalise).filter((m) => m.name);

  const hasCategory = all.some((m) => m.category);
  const food = all.filter((m) => {
    if (NON_FOOD_WORDS.test(m.category) && !FOOD_WORDS.test(m.category)) return false;
    if (hasCategory) return FOOD_WORDS.test(m.category) || FOOD_WORDS.test(m.name);
    return FOOD_WORDS.test(m.name);
  });

  // Count every CDC merchant at each address (food or not) so a building full
  // of stalls is caught even when only some stalls sell food.
  const counts = new Map();
  for (const m of all) {
    const k = placeKey(m);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }

  const areas = Object.fromEntries(AREAS.map((a) => [a.id, { ...a, items: [] }]));
  let removedShared = 0;
  let removedStallPlace = 0;
  const seen = new Set();
  for (const m of food) {
    const area = AREAS.find((a) => a.sectors.includes(m.postal.slice(0, 2)));
    if (!area) continue;
    if ((counts.get(placeKey(m)) || 0) >= SHARED_LIMIT) { removedShared++; continue; }
    if (STALL_PLACE.test(m.address) || STALL_PLACE.test(m.category)) { removedStallPlace++; continue; }
    const dup = `${m.name.toLowerCase()}|${placeKey(m)}`;
    if (seen.has(dup)) continue;
    seen.add(dup);
    areas[area.id].items.push(m);
  }
  for (const a of Object.values(areas)) a.items.sort((x, y) => x.name.localeCompare(y.name));

  return {
    updated: new Date().toISOString(),
    source: 'CDC Vouchers Merchants Go Where (gowhere.gov.sg/cdcvouchers)',
    rules: { sharedLimit: SHARED_LIMIT },
    stats: {
      merchants: all.length,
      foodAndDrink: food.length,
      removedShared,
      removedStallPlace,
      kept: Object.values(areas).reduce((n, a) => n + a.items.length, 0),
    },
    sampleFields: records[0] ? Object.keys(flatten(records[0])) : [],
    areas: Object.values(areas),
  };
}

module.exports = async (req, res) => {
  try {
    if (!cache.data || Date.now() - cache.at > 6 * 36e5) {
      cache = { at: Date.now(), data: await load() };
    }
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 's-maxage=21600, stale-while-revalidate=86400');
    res.end(JSON.stringify(cache.data));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
