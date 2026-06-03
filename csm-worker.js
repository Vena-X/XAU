// ═══════════════════════════════════════════════════
//  VENA-X · CSM WORKER v1.1
//  Dijalankan oleh GitHub Actions tiap 5 menit
//  Fetch CSM dari TwelveData → simpan ke Firebase DB
// ═══════════════════════════════════════════════════

const https  = require('https');
const admin  = require('firebase-admin');

const TWELVE_API_KEY  = process.env.TWELVE_API_KEY;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_SA     = process.env.FIREBASE_SERVICE_ACCOUNT;

const CSM_PAIRS = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','USD/CAD'];

// ── Simple HTTPS GET (no external deps needed) ──────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ── Init Firebase ───────────────────────────────────
function initFirebase() {
  if (admin.apps.length) return;
  const sa = JSON.parse(FIREBASE_SA);
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL: FIREBASE_DB_URL
  });
}

// ── Hitung CSM Score ────────────────────────────────
function calcCSM(rates) {
  const s = { USD:0, EUR:0, GBP:0, JPY:0, CHF:0, AUD:0, CAD:0, XAU:0 };
  if (rates['EUR/USD']) { s.EUR += rates['EUR/USD']/1.10*5; s.USD += (1/rates['EUR/USD'])*5; }
  if (rates['GBP/USD']) { s.GBP += rates['GBP/USD']/1.25*5; s.USD += (1/rates['GBP/USD'])*5; }
  if (rates['USD/JPY']) { s.USD += rates['USD/JPY']/150*5;  s.JPY += (1/rates['USD/JPY'])*1000; }
  if (rates['USD/CHF']) { s.USD += rates['USD/CHF']/0.90*5; s.CHF += (1/rates['USD/CHF'])*5; }
  if (rates['AUD/USD']) { s.AUD += rates['AUD/USD']/0.65*5; s.USD += (1/rates['AUD/USD'])*5; }
  if (rates['USD/CAD']) { s.USD += rates['USD/CAD']/1.35*5; s.CAD += (1/rates['USD/CAD'])*5; }
  if (rates['XAU/USD']) { s.XAU += rates['XAU/USD']/4000*5; }
  const vals = Object.values(s);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const out = {};
  Object.keys(s).forEach(k => {
    out[k] = mx > mn ? Math.round(((s[k]-mn)/(mx-mn))*90+5)/10 : 5;
  });
  return out;
}

// ── Main ─────────────────────────────────────────────
async function main() {
  console.log('[' + new Date().toISOString() + '] CSM Worker v1.1 starting...');

  if (!TWELVE_API_KEY)  { console.error('TWELVE_API_KEY not set');  process.exit(1); }
  if (!FIREBASE_DB_URL) { console.error('FIREBASE_DB_URL not set'); process.exit(1); }
  if (!FIREBASE_SA)     { console.error('FIREBASE_SERVICE_ACCOUNT not set'); process.exit(1); }

  // 1. Fetch harga XAU dari gold-api.com
  let xauPrice = 4464.88;
  try {
    const xauData = await httpsGet('https://api.gold-api.com/price/XAU');
    if (xauData && xauData.price) {
      xauPrice = parseFloat(xauData.price);
      console.log('XAU price: ' + xauPrice);
    }
  } catch(e) {
    console.warn('gold-api.com failed:', e.message, '- using fallback:', xauPrice);
  }

  // 2. Fetch CSM pairs dari TwelveData satu per satu (lebih reliable)
  const rates = {};
  for (const pair of CSM_PAIRS) {
    try {
      const sym = encodeURIComponent(pair);
      const url = 'https://api.twelvedata.com/price?symbol=' + sym + '&apikey=' + TWELVE_API_KEY;
      const data = await httpsGet(url);
      if (data && data.price) {
        rates[pair] = parseFloat(data.price);
        console.log(pair + ': ' + rates[pair]);
      } else {
        console.warn(pair + ' no price:', JSON.stringify(data).slice(0,100));
      }
    } catch(e) {
      console.warn(pair + ' failed:', e.message);
    }
  }

  console.log('CSM pairs fetched: ' + Object.keys(rates).length + ' pairs');

  if (Object.keys(rates).length === 0) {
    console.error('No CSM data received - aborting');
    process.exit(1);
  }

  rates['XAU/USD'] = xauPrice;

  // 3. Hitung CSM score
  const csmScores = calcCSM(rates);
  console.log('CSM scores:', JSON.stringify(csmScores));

  // 4. Simpan ke Firebase
  initFirebase();
  const db  = admin.database();
  const now = new Date();
  const timeStr = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  const utcStr  = String(now.getUTCHours()).padStart(2,'0') + ':' + String(now.getUTCMinutes()).padStart(2,'0') + ' UTC';

  await db.ref('csm/latest').set({
    scores:    csmScores,
    rates:     rates,
    xauPrice:  xauPrice,
    time:      timeStr,
    utc:       utcStr,
    timestamp: now.getTime(),
    updatedAt: now.toISOString(),
  });

  // History max 5
  const histSnap = await db.ref('csm/history').once('value');
  let history = histSnap.val() ? Object.values(histSnap.val()) : [];
  history.unshift({ scores: csmScores, time: timeStr, utc: utcStr, timestamp: now.getTime() });
  history = history.slice(0, 5);
  await db.ref('csm/history').set(history);

  console.log('Firebase updated at ' + utcStr);
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
