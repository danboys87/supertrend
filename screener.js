'use strict';
/**
 * Screener UT Bot + Volume SuperTrend (4H) dengan dashboard web.
 * Mode: PAPER (mencatat posisi virtual dari sinyal). TIDAK mengirim order ke exchange.
 *
 * Jalankan : node screener.js   ->  buka http://localhost:3000
 * Env      : PORT, DATA_DIR (folder state.json + config.json), DASHBOARD_TOKEN (opsional, sangat disarankan di Railway),
 *            TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (opsional, notifikasi)
 * Jadwal   : tiap close candle 4H (00/04/08/12/16/20 UTC) + delaySec (default 30 detik)
 */
const fs = require('fs'), path = require('path'), http = require('http');
const { evaluateLast, mergeConfig, stopLossPrice, computeSignals, utBot, DEFAULT_CONFIG } = require('./strategy');
const { getUniverse } = require('./universe');
if (!mergeConfig().stopLoss || typeof stopLossPrice !== 'function') {
  console.error('ERROR: strategy.js adalah versi lama (belum ada stop loss). Ganti dengan strategy.js terbaru lalu jalankan lagi.');
  process.exit(1);
}

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DIR, { recursive: true });
const CFG_FILE = path.join(DIR, 'config.json'), ST_FILE = path.join(DIR, 'state.json');
const BAR_MS = 4 * 3600 * 1000;

const DEFAULTS = {
  pairs: ['HYPE-USDT'],      // format OKX. Selalu ikut discan, juga di mode coingecko
  universe: {
    mode: 'coingecko',       // 'coingecko' = top N CoinGecko + pairs di atas | 'manual' = hanya daftar pairs di atas
    topN: 150,               // 100 / 150 / 200 (maks 250)
    excludeStable: true,     // buang stablecoin
    excludeWrapped: true,    // buang token wrapped / staked (WBTC, stETH, dll)
    refreshHours: 24,        // seberapa sering daftar koin diperbarui dari CoinGecko
  },
  delaySec: 30,              // jeda setelah close candle
  positionSizeUsdt: 100,     // ukuran posisi virtual per trade
  feePct: 0.1,               // fee per sisi (%)
  maxOpenPositions: 3,
  management: {              // manajemen posisi terbuka, jalan terpisah dari scan 4H
    enabled: true,
    intervalSec: 60,         // seberapa sering posisi dicek (pakai candle 1 menit yang sudah close)
    trailing: {
      enabled: true,
      activateProfitPct: 15, // trailing aktif saat harga puncak sudah +15% dari entry
      lockProfitPct: 1,      // saat aktif, stop loss dinaikkan ke entry +1%
      trailDistancePct: null // opsional: setelah aktif, stop mengikuti puncak dengan jarak % ini (null = stop tetap di entry +1%)
    },
  },
  regime: {                  // filter kondisi pasar: entry BARU hanya boleh kalau kondisi acuan (BTC) OK
    enabled: true,           // ON/OFF
    mode: 'sma200',          // 'sma200' = BTC di atas rata-rata 200 candle 4H | 'utvst' = UT Bot BTC naik DAN Volume ST BTC bullish | 'ut2' = UT Bot BTC naik
    ref: 'BTC-USDT',
  },
  ranking: {                 // kalau sinyal BUY lebih banyak dari slot kosong
    enabled: true,           // ON = urut skor, OFF = urut peringkat market cap
    by: 'score',             // 'score' = rata-rata peringkat (lonjakan volume + risiko rendah) | 'marketcap'
    minVolume24hUsdt: 0,     // koin dengan volume 24 jam di bawah ini tidak dipertimbangkan (0 = tanpa syarat)
  },
  maxSignalAgeMin: 10,       // sinyal lebih tua dari ini (menit sejak close candle) tidak dibuka jadi posisi
  timezone: 'Asia/Jakarta',  // hanya untuk tampilan dashboard
  strategy: {},              // override DEFAULT_CONFIG di strategy.js (kosong = setting HYPE bawaan)
};
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }; // dipakai untuk state.json
const mergeDeep = (a, b) => {
  const o = { ...a };
  for (const k of Object.keys(b || {})) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' ? mergeDeep(a[k], b[k]) : b[k];
  return o;
};

// ───────── Konfigurasi: bawaan kode < data/config.json < variabel lingkungan CONFIG_JSON ─────────
// JSON yang rusak = bot TIDAK dijalankan (lebih aman daripada diam-diam memakai nilai bawaan).
function parseOrDie(text, label) {
  try { return JSON.parse(text); } catch (e) {
    console.error(`\nERROR: ${label} bukan JSON yang valid: ${e.message}\nPeriksa koma antar baris, tanda kutip, dan kurung. Bot tidak dijalankan.`);
    process.exit(1);
  }
}
const REF_KEYS = { ...DEFAULTS, strategy: DEFAULT_CONFIG }; // untuk mendeteksi nama pengaturan yang salah ketik
function unknownKeys(user, ref, prefix = '') {
  const out = [];
  for (const k of Object.keys(user || {})) {
    if (!(k in ref)) out.push(prefix + k);
    else if (user[k] && typeof user[k] === 'object' && !Array.isArray(user[k]) && ref[k] && typeof ref[k] === 'object' && !Array.isArray(ref[k])) out.push(...unknownKeys(user[k], ref[k], `${prefix}${k}.`));
  }
  return out;
}
const configWarnings = [];
const fileExists = fs.existsSync(CFG_FILE);
const fileCfg = fileExists ? parseOrDie(fs.readFileSync(CFG_FILE, 'utf8'), CFG_FILE) : {};
const envCfg = process.env.CONFIG_JSON ? parseOrDie(process.env.CONFIG_JSON, 'Variabel lingkungan CONFIG_JSON') : {};
for (const [src, obj] of [['config.json', fileCfg], ['CONFIG_JSON', envCfg]]) {
  const bad = unknownKeys(obj, REF_KEYS);
  if (bad.length) configWarnings.push(`${src}: pengaturan tidak dikenal (kemungkinan salah ketik, diabaikan): ${bad.join(', ')}`);
}
const baseCfg = mergeDeep(DEFAULTS, fileCfg);
if (!fileExists) fs.writeFileSync(CFG_FILE, JSON.stringify(baseCfg, null, 2)); // contoh pengaturan, tanpa isi CONFIG_JSON
const config = mergeDeep(baseCfg, envCfg);
const configSource = process.env.CONFIG_JSON ? 'config.json + variabel CONFIG_JSON (CONFIG_JSON menang)' : fileExists ? 'config.json' : 'bawaan kode (config.json baru dibuat)';
const state = { positions: [], trades: [], status: {}, lastCandle: {}, lastScan: null, nextScan: null, log: [], ...readJson(ST_FILE, {}) };
const save = () => fs.writeFileSync(ST_FILE, JSON.stringify(state, null, 2));

function log(m) {
  console.log(new Date().toISOString(), m);
  state.log.unshift({ t: Date.now(), m });
  state.log.length = Math.min(state.log.length, 100);
}
async function notify(text) {
  const t = process.env.TELEGRAM_BOT_TOKEN, c = process.env.TELEGRAM_CHAT_ID;
  if (!t || !c) return;
  try {
    await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: c, text }),
    });
  } catch (e) { log('Telegram gagal: ' + e.message); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Candle OKX yang sudah close (confirm = 1), urut lama -> baru. Retry 2x kalau gagal / kena rate limit.
async function fetchCandles(instId, bar = '4H', limit = 300) {
  const mock = bar === '1m' ? global.__mock1m : global.__mock; // hook untuk tes
  if (mock) return mock(instId, limit);
  for (let a = 0; ; a++) {
    try {
      const j = await (await fetch(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`)).json();
      if (j.code !== '0') throw new Error(j.msg || j.code);
      return j.data.filter((r) => r[8] === '1')
        .map((r) => ({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })).reverse();
    } catch (e) {
      if (a >= 2) throw e;
      await sleep(800 * (a + 1));
    }
  }
}

function closePos(p, price, time, reason) {
  const f = config.feePct / 100;
  const pnl = (price / p.entryPrice) * (1 - f) * (1 - f) - 1;
  state.positions = state.positions.filter((x) => x !== p);
  state.trades.unshift({ ...p, exitPrice: price, exitTime: time, reason, pnlPct: +(pnl * 100).toFixed(2), pnlUsdt: +(p.sizeUsdt * pnl).toFixed(2) });
  log(`SELL ${p.pair} @ ${price} (${reason}) PnL ${(pnl * 100).toFixed(2)}%`);
  notify(`🔴 SELL ${p.pair}\nHarga ${price} | ${reason}\nPnL ${(pnl * 100).toFixed(2)}% (${(p.sizeUsdt * pnl).toFixed(2)} USDT)`);
}

async function scanPair(meta) {
  if (typeof meta === 'string') meta = { pair: meta, rank: null, name: meta.split('-')[0] };
  const pair = meta.pair;
  const candles = await fetchCandles(pair);
  if (candles.length < 200) return 'skip'; // listing baru / data kurang
  const last = candles[candles.length - 1];
  const r = evaluateLast(candles, config.strategy);
  // sinyal dianggap "segar" kalau candle baru saja close (bukan hasil start ulang / scan manual yang terlambat)
  const ageMin = Math.round((Date.now() - (last.time + BAR_MS)) / 60000);
  const fresh = global.__mock && !global.__mockStale ? true : ageMin <= config.maxSignalAgeMin;
  state.status[pair] = {
    rank: meta.rank, name: meta.name, time: last.time, price: last.close,
    utTrendUp: r.ut.trendUp, vstDirBull: r.vst.dirBull, vstColorBull: r.vst.colorBull,
    signal: r.entry ? 'BUY' : r.exit ? 'SELL' : '-', stale: (r.entry || r.exit) && !fresh, ageMin,
  };
  if (state.lastCandle[pair] === last.time) return 'ok'; // candle ini sudah diproses
  state.lastCandle[pair] = last.time;

  const pos = state.positions.find((p) => p.pair === pair);
  const tag = meta.rank ? ` (#${meta.rank})` : '';

  if (pos) {
    // 1) stop loss intrabar: ada candle sejak entry yang low-nya menyentuh SL
    const sl = pos.stopLoss;
    const since = pos.slSince ?? pos.entryTime; // hanya candle setelah level SL saat ini dipasang
    const hit = Number.isFinite(sl) ? candles.find((c) => c.time >= since && c.low <= sl) : null;
    if (hit) { closePos(pos, Math.min(hit.open, sl), hit.time + BAR_MS, pos.trailActive ? 'Trailing stop' : 'Stop loss'); return 'ok'; }
    // 2) UT sell (atau, kalau bot sempat mati, UT sudah trend turun)
    if (r.exit || (!fresh && !r.ut.trendUp)) closePos(pos, last.close, last.time + BAR_MS, r.exit ? 'UT sell' : 'UT trend turun (catch-up)');
  } else if (r.entry && fresh) {
    candidates.push({ meta, price: last.close, time: last.time, atr: r.atr, ...entryMetrics(candles, r.atr) }); // dibuka/ditolak setelah semua pair discan
  } else if (r.entry) {
    log(`Sinyal BUY ${pair}${tag} sudah lewat (${ageMin} menit setelah close, batas ${config.maxSignalAgeMin}), tidak dibuka jadi posisi`);
  }
  return 'ok';
}

// ───────── Manajemen posisi (tiap intervalSec): stop loss + trailing, pakai candle 1 menit yang sudah close ─────────
let managing = false;
async function managePosition(pos) {
  const T = config.management.trailing;
  pos.peak ??= pos.entryPrice; pos.checkedUntil ??= pos.entryTime; pos.slSince ??= pos.entryTime;
  const need = Math.min(300, Math.ceil((Date.now() - pos.checkedUntil) / 60000) + 2);
  const cs = (await fetchCandles(pos.pair, '1m', need)).filter((c) => c.time >= pos.checkedUntil);
  const raise = (v, c, why) => {
    if (Number.isFinite(pos.stopLoss) && v <= pos.stopLoss) return;
    const first = !pos.trailActive;
    pos.stopLoss = v; pos.slSince = c.time + 60000;
    if (why) { log(`${why} ${pos.pair}: stop loss naik ke ${v.toFixed(4)}`); if (first) notify(`🔒 ${why} ${pos.pair}\nStop loss naik ke ${v.toFixed(4)} (entry ${pos.entryPrice})`); }
  };
  for (const c of cs) {
    // 1) stop loss dicek lebih dulu dengan level SEBELUM candle ini (konservatif)
    if (Number.isFinite(pos.stopLoss) && c.low <= pos.stopLoss) {
      return closePos(pos, Math.min(c.open, pos.stopLoss), c.time + 60000, pos.trailActive ? 'Trailing stop' : 'Stop loss');
    }
    // 2) puncak harga, aktivasi trailing, dan (opsional) stop mengikuti puncak
    pos.peak = Math.max(pos.peak, c.high);
    if (T.enabled) {
      if (!pos.trailActive && pos.peak >= pos.entryPrice * (1 + T.activateProfitPct / 100)) {
        raise(pos.entryPrice * (1 + T.lockProfitPct / 100), c, 'Trailing aktif');
        pos.trailActive = true;
      }
      if (pos.trailActive && T.trailDistancePct != null) raise(pos.peak * (1 - T.trailDistancePct / 100), c, null);
    }
    pos.checkedUntil = c.time + 60000;
    pos.lastPrice = c.close;
  }
  pos.lastCheck = Date.now();
}
async function managePositions() {
  if (!config.management.enabled || managing || !state.positions.length) return;
  managing = true;
  try {
    for (const p of [...state.positions]) { try { await managePosition(p); } catch (e) { log(`Manajemen ${p.pair}: ${e.message}`); } }
    save();
  } finally { managing = false; }
}

let universe = null;
// daftar yang discan: universe CoinGecko (kalau aktif) + config.pairs + semua pair yang punya posisi terbuka, urut peringkat
async function resolvePairs() {
  const u = config.universe;
  const map = new Map();
  if (u.mode === 'coingecko') {
    universe = await getUniverse(u, DIR, log);
    for (const x of (universe && universe.pairs) || []) map.set(x.pair, x);
  }
  for (const p of [...config.pairs, ...state.positions.map((x) => x.pair)]) {
    if (!map.has(p)) map.set(p, { pair: p, rank: null, name: p.split('-')[0] });
  }
  return [...map.values()].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
}

// ───────── Filter kondisi pasar + ranking kandidat ─────────
const candidates = [];
const entryMetrics = (c, atr) => {
  const i = c.length - 1;
  let vol24 = 0; for (let j = Math.max(0, i - 5); j <= i; j++) vol24 += c[j].close * c[j].volume; // 6 candle 4H terakhir, dalam USDT
  let m = 0, n = 0; for (let j = Math.max(0, i - 20); j < i; j++) { m += c[j].volume; n++; }
  return { vol24, surge: n && m ? c[i].volume / (m / n) : 0, risk: atr / c[i].close };
};

async function computeRegime() {
  const R = config.regime;
  if (!R.enabled) return { enabled: false, ok: true };
  const c = await fetchCandles(R.ref, '4H', 300);
  if (c.length < 250) throw new Error(`data acuan ${R.ref} kurang (${c.length} candle)`);
  const last = c[c.length - 1], out = { enabled: true, mode: R.mode, ref: R.ref, time: last.time, price: last.close };
  if (R.mode === 'sma200') {
    out.sma200 = c.slice(-200).reduce((a, k) => a + k.close, 0) / 200;
    out.ok = last.close > out.sma200;
  } else {
    out.utUp = utBot(c, { key: 2, atr: 10 }).trendUp.at(-1);
    out.ok = out.utUp;
    if (R.mode === 'utvst') { out.vstBull = computeSignals(c, { entryWindow: 0 }).vst.dirBull.at(-1); out.ok = out.utUp && out.vstBull; }
  }
  return out;
}

// urutan terkecil = dipilih dulu. 'score' = rata-rata peringkat lonjakan volume (besar lebih baik) dan risiko ATR/harga (kecil lebih baik)
function rankCandidates(cs) {
  const byCap = (a, b) => (a.meta.rank ?? 1e9) - (b.meta.rank ?? 1e9);
  if (!config.ranking.enabled || config.ranking.by === 'marketcap') return cs.sort(byCap);
  [...cs].sort((a, b) => b.surge - a.surge).forEach((x, r) => { x.rs = r; });
  [...cs].sort((a, b) => a.risk - b.risk).forEach((x, r) => { x.rr = r; });
  cs.forEach((x) => { x.score = x.rs + x.rr; });
  return cs.sort((a, b) => a.score - b.score || byCap(a, b));
}

function openPosition(c) {
  const sl = stopLossPrice(c.price, c.atr, config.strategy), entryTime = c.time + BAR_MS, pair = c.meta.pair;
  state.positions.push({
    pair, entryPrice: c.price, entryTime, stopLoss: Number.isFinite(sl) ? sl : null, sizeUsdt: config.positionSizeUsdt,
    peak: c.price, trailActive: false, slSince: entryTime, checkedUntil: entryTime, lastPrice: c.price, lastCheck: Date.now(),
  });
  const tag = c.meta.rank ? ` (#${c.meta.rank})` : '';
  const why = c.score != null ? `\nRanking: skor ${c.score}, lonjakan volume ${c.surge.toFixed(1)}x, risiko ${(c.risk * 100).toFixed(1)}%` : '';
  log(`BUY ${pair}${tag} @ ${c.price} | SL ${Number.isFinite(sl) ? sl.toFixed(4) : '-'}${c.score != null ? ` | skor ${c.score}` : ''}`);
  notify(`🟢 BUY ${pair}${tag}\nHarga ${c.price}\nStop loss ${Number.isFinite(sl) ? sl.toFixed(4) : '-'}\nUkuran ${config.positionSizeUsdt} USDT (paper)${why}`);
}

// dipanggil setelah semua pair discan: terapkan filter pasar, ranking, dan isi slot yang kosong
function processCandidates() {
  const list = candidates.splice(0), R = state.regime || { ok: true }, out = [];
  const minVol = config.ranking.minVolume24hUsdt || 0, pool = [];
  const pub = (c, result) => ({ pair: c.meta.pair, rank: c.meta.rank, price: c.price, surge: c.surge, risk: c.risk, vol24: c.vol24, score: c.score ?? null, result });
  for (const c of list) {
    if (!R.ok) out.push(pub(c, 'Ditahan filter pasar'));
    else if (c.vol24 < minVol) out.push(pub(c, 'Volume 24 jam kecil'));
    else pool.push(c);
  }
  const slots = Math.max(0, config.maxOpenPositions - state.positions.length), opened = [];
  rankCandidates(pool).forEach((c, i) => {
    if (i < slots) { openPosition(c); opened.push(pub(c, 'Dibuka')); }
    else { out.push(pub(c, 'Tidak kebagian slot')); log(`Sinyal BUY ${c.meta.pair} tidak kebagian slot (${config.maxOpenPositions} posisi penuh)`); }
  });
  out.unshift(...opened); // yang dibuka tampil paling atas, tetap urut ranking
  const held = list.filter((c) => !R.ok).length;
  if (held) log(`${held} sinyal BUY ditahan filter pasar (${R.ref || 'acuan'} ${config.regime.mode})`);
  state.candidates = { time: Date.now(), list: out };
}

let scanning = false;
async function scanAll() {
  if (scanning) return;
  scanning = true;
  const t0 = Date.now();
  try {
    candidates.length = 0;
    try { state.regime = await computeRegime(); }
    catch (e) { state.regime = { enabled: true, mode: config.regime.mode, ref: config.regime.ref, ok: false, error: e.message }; log(`Filter pasar gagal dihitung (${e.message}), entry baru ditahan`); }
    const list = await resolvePairs();
    const keep = new Set(list.map((m) => m.pair));
    for (const k of Object.keys(state.status)) if (!keep.has(k)) delete state.status[k];
    let ok = 0, skip = 0;
    const errs = [];
    for (const m of list) {
      try { (await scanPair(m)) === 'skip' ? skip++ : ok++; } catch (e) { errs.push(`${m.pair}: ${e.message}`); }
      if (list.length > 5) await sleep(150); // jaga rate limit OKX
    }
    processCandidates();
    state.scanInfo = { pairs: list.length, ok, skip, errors: errs.length, seconds: Math.round((Date.now() - t0) / 1000) };
    log(`Scan selesai: ${list.length} pair (ok ${ok}, dilewati ${skip}, error ${errs.length}) dalam ${state.scanInfo.seconds} dtk`);
    if (errs.length) log('Contoh error: ' + errs.slice(0, 3).join(' | '));
    state.lastScan = Date.now();
    save();
  } catch (e) {
    log('Scan gagal: ' + e.message);
  } finally { scanning = false; }
}

// jadwal: boundary 4H (UTC) + delaySec
function scheduleNext() {
  const now = Date.now();
  let t = Math.floor(now / BAR_MS) * BAR_MS + config.delaySec * 1000;
  if (t <= now) t += BAR_MS;
  state.nextScan = t;
  setTimeout(async () => { await scanAll(); scheduleNext(); }, t - now);
}

function startServer() {
  const ok = (req) => !process.env.DASHBOARD_TOKEN || req.headers['x-token'] === process.env.DASHBOARD_TOKEN;
  const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/') return send(res, 200, fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'), 'text/html; charset=utf-8');
    if (u.startsWith('/api/')) {
      if (!ok(req)) return send(res, 401, 'unauthorized', 'text/plain');
      if (u === '/api/state') {
        return send(res, 200, {
          config: { ...config, strategy: mergeConfig(config.strategy) }, positions: state.positions, trades: state.trades.slice(0, 500),
          configInfo: { source: configSource, warnings: configWarnings }, status: state.status, regime: state.regime, candidates: state.candidates, scanInfo: state.scanInfo, universe: universe ? { updated: universe.updated, count: universe.pairs.length, stats: universe.stats } : null, lastScan: state.lastScan, nextScan: state.nextScan, log: state.log.slice(0, 30), now: Date.now(),
        });
      }
      if (u === '/api/scan' && req.method === 'POST') { scanAll(); return send(res, 200, { ok: true }); }
    }
    send(res, 404, 'not found', 'text/plain');
  }).listen(process.env.PORT || 3000, () => log(`Dashboard di port ${process.env.PORT || 3000}`));
}

if (require.main === module) {
  for (const w of configWarnings) { console.warn('PERINGATAN konfigurasi: ' + w); log('PERINGATAN konfigurasi: ' + w); }
  if (!process.env.DASHBOARD_TOKEN) console.warn('PERINGATAN: DASHBOARD_TOKEN belum diset, dashboard terbuka untuk siapa saja yang tahu URL-nya.');
  startServer();
  scanAll().then(scheduleNext);
  if (config.management.enabled) setInterval(managePositions, Math.max(10, config.management.intervalSec) * 1000);
}
module.exports = { scanPair, scanAll, resolvePairs, managePositions, computeRegime, processCandidates, rankCandidates, candidates, state, config };
