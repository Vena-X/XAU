// ═══════════════════════════════════════════════════
//  VENA-X · CSM WORKER
//  Dijalankan oleh Render Cron Job tiap 2 menit
//  Fetch CSM dari TwelveData → simpan ke Firebase DB
//  API key TIDAK ada di HTML — aman
// ═══════════════════════════════════════════════════

const fetch   = require('node-fetch');
const admin   = require('firebase-admin');

// ── CONFIG (dari Environment Variables Render) ──────
const TWELVE_API_KEY = process.env.TWELVE_API_KEY;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_SA    = process.env.FIREBASE_SERVICE_ACCOUNT; // JSON string

// ── CSM PAIRS ───────────────────────────────────────
const CSM_PAIRS = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','USD/CAD'];

// ── INIT FIREBASE ───────────────────────────────────
function initFirebase() {
  if (admin.apps.length) return;
  let credential;
  if (FIREBASE_SA) {
    const sa = JSON.parse(FIREBASE_SA);
    credential = admin.credential.cert(sa);
  } else {
    // Fallback: gunakan Application Default Credentials
    credential = admin.credential.applicationDefault();
  }
  admin.initializeApp({ credential, databaseURL: FIREBASE_DB_URL });
}

// ── HITUNG CSM ──────────────────────────────────────
function calcCSM(rates) {
  const strength = { USD:0, EUR:0, GBP:0, JPY:0, CHF:0, AUD:0, CAD:0, XAU:0 };
  if (rates['EUR/USD']) { strength.EUR += rates['EUR/USD']/1.10*5; strength.USD += (1/rates['EUR/USD'])*5; }
  if (rates['GBP/USD']) { strength.GBP += rates['GBP/USD']/1.25*5; strength.USD += (1/rates['GBP/USD'])*5; }
  if (rates['USD/JPY']) { strength.USD += rates['USD/JPY']/150*5;  strength.JPY += (1/rates['USD/JPY'])*1000; }
  if (rates['USD/CHF']) { strength.USD += rates['USD/CHF']/0.90*5; strength.CHF += (1/rates['USD/CHF'])*5; }
  if (rates['AUD/USD']) { strength.AUD += rates['AUD/USD']/0.65*5; strength.USD += (1/rates['AUD/USD'])*5; }
  if (rates['USD/CAD']) { strength.USD += rates['USD/CAD']/1.35*5; strength.CAD += (1/rates['USD/CAD'])*5; }
  if (rates['XAU/USD']) { strength.XAU += rates['XAU/USD']/4000*5; }

  const vals = Object.values(strength);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const out = {};
  Object.keys(strength).forEach(k => {
    out[k] = mx > mn ? Math.round(((strength[k]-mn)/(mx-mn))*90+5)/10 : 5;
  });
  return out;
}

// ── MAIN ─────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] CSM Worker starting...`);

  if (!TWELVE_API_KEY) { console.error('❌ TWELVE_API_KEY not set'); process.exit(1); }
  if (!FIREBASE_DB_URL) { console.error('❌ FIREBASE_DB_URL not set'); process.exit(1); }

  // 1. Fetch harga XAU dari gold-api.com (gratis, no key)
  let xauPrice = 4464.88;
  try {
    const xauRes = await fetch('https://api.gold-api.com/price/XAU', { timeout: 8000 });
    const xauData = await xauRes.json();
    if (xauData && xauData.price) xauPrice = parseFloat(xauData.price);
    console.log(`✅ XAU price: ${xauPrice}`);
  } catch(e) {
    console.warn('⚠️ gold-api.com failed, using last known price:', xauPrice);
  }

  // 2. Fetch CSM pairs dari TwelveData (1 call, multi-symbol)
  const syms = CSM_PAIRS.join(',');
  const url  = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(syms)}&apikey=${TWELVE_API_KEY}`;
  let rates  = {};
  try {
    const res  = await fetch(url, { timeout: 10000 });
    const data = await res.json();
    CSM_PAIRS.forEach(p => {
      const key = p.replace('/','');
      if (data[key] && data[key].price) rates[p] = parseFloat(data[key].price);
    });
    console.log(`✅ CSM pairs fetched: ${Object.keys(rates).length} pairs`);
  } catch(e) {
    console.error('❌ TwelveData fetch failed:', e.message);
    process.exit(1);
  }

  if (Object.keys(rates).length === 0) {
    console.error('❌ No CSM data received');
    process.exit(1);
  }

  // Tambahkan XAU
  rates['XAU/USD'] = xauPrice;

  // 3. Hitung CSM score
  const csmScores = calcCSM(rates);
  console.log('✅ CSM scores:', csmScores);

  // 4. Simpan ke Firebase Realtime DB
  initFirebase();
  const db  = admin.database();
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const utcStr  = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')} UTC`;

  // Simpan data terbaru
  await db.ref('csm/latest').set({
    scores:    csmScores,
    rates:     rates,
    xauPrice:  xauPrice,
    time:      timeStr,
    utc:       utcStr,
    timestamp: now.getTime(),
    updatedAt: now.toISOString(),
  });

  // Simpan ke history (max 5 snapshot)
  const histRef  = db.ref('csm/history');
  const histSnap = await histRef.once('value');
  let history    = histSnap.val() ? Object.values(histSnap.val()) : [];

  history.unshift({
    scores:    csmScores,
    time:      timeStr,
    utc:       utcStr,
    timestamp: now.getTime(),
  });

  // Simpan hanya 5 terbaru
  history = history.slice(0, 5);
  await histRef.set(history);

  console.log(`✅ Firebase updated at ${utcStr}`);
  console.log(`✅ History: ${history.length} snapshots`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
