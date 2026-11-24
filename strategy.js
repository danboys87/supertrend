'use strict';
// Atribusi & lisensi:
//  - Logika Volume SuperTrend AI di file ini adalah port ke JavaScript dari indikator TradingView "Volume SuperTrend AI"
//    (c) Zeiierman, lisensi CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/):
//    wajib mencantumkan atribusi, tidak boleh untuk komersial, dan turunannya harus dibagikan dengan lisensi yang sama.
//  - Logika UT Bot Alerts adalah port dari skrip TradingView "UT Bot Alerts" (periksa lisensi aslinya sebelum membagikan).
/**
 * Volume SuperTrend AI (Zeiierman) + UT Bot Alerts  ->  kombinasi sinyal BUY (spot, long only)
 *
 * PENTING: semua fungsi harus diberi candle yang SUDAH CLOSE saja.
 * Kalau ambil candle dari exchange, buang candle terakhir yang masih berjalan.
 * Format candle: { time, open, high, low, close, volume } (urut lama -> baru)
 */

// ───────────────────────── KONFIGURASI (semua toggle ada di sini) ─────────────────────────
// SETTING AKTIF = preset HYPE-USDT 4H (varian D key 2 dari hasil backtest):
//   UT Bot key 2 / ATR 10, Volume ST arah bullish (direction == -1), exit = UT sell key 2, entryWindow 0
const DEFAULT_CONFIG = {
  utBot: {
    enabled: true,        // ON/OFF UT Bot sebagai trigger entry
    key: 2,               // Key Value (a)
    atr: 10,              // ATR period (c)
  },
  vst: {
    len: 10,              // panjang WMA volume & ATR
    factor: 3.0,          // pengali ATR
    priceLen: 20,         // KNN_PriceLen
    stLen: 100,           // KNN_STLen
    k: 3,                 // KNN neighbors
    n: 10,                // KNN data points
    // Definisi "hijau / buy" untuk Volume SuperTrend. Dua toggle ini bisa dikombinasi:
    requireColor: false,      // OPSI 1: warna garis hijau  (label_ == 1)  -> ini yang terlihat di chart
    requireDirection: true,   // OPSI 2: arah SuperTrend bullish (direction == -1, harga di atas band bawah)
    // keduanya true  = paling ketat (sinyal paling sedikit)
    // keduanya false = Volume SuperTrend tidak dipakai sama sekali
  },
  // UT buy boleh terjadi sampai N candle lalu, selama Volume ST OK sekarang dan UT masih trend naik.
  // 0 = UT buy dan Volume ST hijau harus di candle yang SAMA (persis permintaan awal).
  entryWindow: 0,
  // Stop loss tetap dari harga entry, dicek INTRABAR (pakai low candle), seperti stop order di exchange.
  // Catatan: UT sell hanya dicek di close, jadi stop loss ini yang melindungi dari wick/gap yang dalam.
  stopLoss: {
    mode: 'atr',          // 'off' | 'atr' | 'percent'
    atrMult: 3,           // mode 'atr'    : SL = harga entry - atrMult x ATR(utBot.atr) candle terakhir sebelum entry
    percent: 8,           // mode 'percent': SL = harga entry x (1 - percent/100)
  },
  exit: {
    onUTSell: true,       // keluar saat UT Bot sell
    utKey: null,          // null = exit pakai sinyal UT sell dari key entry (key 2)
                          // angka = trailing stop gaya UT dengan key tsb, dihitung dari titik entry
    onVSTBad: false,      // keluar saat Volume ST tidak lagi OK (otomatis true kalau UT Bot dimatikan)
  },
};

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(extra || {})) {
    const v = extra[key];
    out[key] = v && typeof v === 'object' && !Array.isArray(v) && base[key] && typeof base[key] === 'object'
      ? deepMerge(base[key], v) : v;
  }
  return out;
}
const mergeConfig = (user) => deepMerge(DEFAULT_CONFIG, user || {});

// ───────────────────────── Helper matematika (meniru Pine) ─────────────────────────
const fin = Number.isFinite;

function trueRange(c) {
  return c.map((k, i) => i === 0
    ? k.high - k.low
    : Math.max(k.high - k.low, Math.abs(k.high - c[i - 1].close), Math.abs(k.low - c[i - 1].close)));
}

// ta.rma: seed pertama = SMA(len), lalu (prev*(len-1)+x)/len
function rma(src, len) {
  const out = new Array(src.length).fill(NaN);
  if (src.length < len) return out;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += src[i];
  out[len - 1] = sum / len;
  for (let i = len; i < src.length; i++) out[i] = (out[i - 1] * (len - 1) + src[i]) / len;
  return out;
}

// ta.wma: bobot 1..len (terbaru = bobot terbesar). NaN di dalam window -> NaN (sama seperti Pine)
function wma(src, len) {
  const out = new Array(src.length).fill(NaN);
  const denom = (len * (len + 1)) / 2;
  for (let i = len - 1; i < src.length; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < len; j++) {
      const v = src[i - len + 1 + j];
      if (!fin(v)) { ok = false; break; }
      s += v * (j + 1);
    }
    if (ok) out[i] = s / denom;
  }
  return out;
}

// ───────────────────────── Volume SuperTrend AI ─────────────────────────
function volumeSuperTrend(candles, p) {
  const n = candles.length;
  const close = candles.map((k) => k.close);
  const num = wma(candles.map((k) => k.close * k.volume), p.len);
  const den = wma(candles.map((k) => k.volume), p.len);
  const vw = num.map((v, i) => (den[i] > 0 ? v / den[i] : NaN)); // guard volume = 0
  const atr = rma(trueRange(candles), p.len);

  const upper = new Array(n).fill(NaN), lower = new Array(n).fill(NaN);
  const st = new Array(n).fill(NaN), direction = new Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    if (!fin(atr[i]) || !fin(vw[i])) continue;
    let up = vw[i] + p.factor * atr[i];
    let lo = vw[i] - p.factor * atr[i];
    const pLo = i > 0 && fin(lower[i - 1]) ? lower[i - 1] : 0; // nz()
    const pUp = i > 0 && fin(upper[i - 1]) ? upper[i - 1] : 0;
    const pClose = i > 0 ? close[i - 1] : NaN;

    lo = (lo > pLo || pClose < pLo) ? lo : pLo;
    up = (up < pUp || pClose > pUp) ? up : pUp;

    let d;
    if (i === 0 || !fin(atr[i - 1])) d = 1;
    else if (st[i - 1] === pUp) d = close[i] > up ? -1 : 1;
    else d = close[i] < lo ? 1 : -1;

    upper[i] = up; lower[i] = lo; direction[i] = d;
    st[i] = d === -1 ? lo : up;
  }

  // --- "AI" KNN (diport penuh sesuai Pine, bukan penyederhanaan) ---
  const price = wma(close, p.priceLen);
  const sT = wma(st, p.stLen);
  const lab = price.map((v, i) => (v > sT[i] ? 1 : 0)); // NaN -> 0, sama seperti Pine
  const nn = Math.max(p.k, p.n);
  const label = new Array(n).fill(NaN);

  for (let i = nn - 1; i < n; i++) {
    const data = [], labels = [];
    let ok = true;
    for (let j = 0; j < nn; j++) {
      const v = st[i - j];
      if (!fin(v)) { ok = false; break; }
      data.push(v); labels.push(lab[i - j]);
    }
    if (!ok) continue;
    const x = st[i];
    const order = data.map((v, j) => ({ d: Math.abs(x - v), j })).sort((a, b) => a.d - b.d || a.j - b.j);
    let ws = 0, tw = 0;
    for (let m = 0; m < p.k; m++) {
      const w = 1 / (order[m].d + 1e-6);
      ws += w * labels[order[m].j];
      tw += w;
    }
    label[i] = ws / tw;
  }

  return {
    superTrend: st,
    direction,                                    // -1 = bullish, 1 = bearish (konvensi Pine)
    label,                                        // 1 = hijau, 0 = merah, di antaranya = netral (biru)
    colorBull: label.map((v) => v === 1),
    colorBear: label.map((v) => v === 0),
    dirBull: direction.map((v) => v === -1),
    dirBear: direction.map((v) => v === 1),
  };
}

// ───────────────────────── UT Bot Alerts ─────────────────────────
function utBot(candles, { key, atr: c }) {
  const n = candles.length;
  const close = candles.map((k) => k.close);
  const atr = rma(trueRange(candles), c);
  const stop = new Array(n).fill(NaN);
  const buy = new Array(n).fill(false), sell = new Array(n).fill(false), trendUp = new Array(n).fill(false);
  const first = c - 1;

  for (let i = first; i < n; i++) {
    const src = close[i];
    const prevSrc = i > 0 ? close[i - 1] : NaN;
    const prev = i > first ? stop[i - 1] : 0; // nz(prev, 0)
    const nLoss = key * atr[i];

    if (src > prev && prevSrc > prev) stop[i] = Math.max(prev, src - nLoss);
    else if (src < prev && prevSrc < prev) stop[i] = Math.min(prev, src + nLoss);
    else stop[i] = src > prev ? src - nLoss : src + nLoss;

    trendUp[i] = src > stop[i];
    if (i > first) {
      // ema(src,1) == src, jadi crossover(ema, stop) == crossover(close, stop)
      buy[i] = src > stop[i] && prevSrc <= stop[i - 1];
      sell[i] = src < stop[i] && stop[i - 1] <= prevSrc;
    }
  }
  return { stop, buy, sell, trendUp, atr };
}

// ───────────────────────── Gabungan sinyal ─────────────────────────
function computeSignals(candles, userCfg) {
  const cfg = mergeConfig(userCfg);
  const n = candles.length;
  const utOn = cfg.utBot.enabled;
  const vstActive = cfg.vst.requireColor || cfg.vst.requireDirection;
  if (!utOn && !vstActive) throw new Error('Minimal satu indikator harus ON (UT Bot atau Volume SuperTrend).');

  const ut = utBot(candles, cfg.utBot);
  const vst = volumeSuperTrend(candles, cfg.vst);

  const vstOk = new Array(n).fill(true);
  if (vstActive) {
    for (let i = 0; i < n; i++) {
      vstOk[i] = (!cfg.vst.requireColor || vst.colorBull[i]) && (!cfg.vst.requireDirection || vst.dirBull[i]);
    }
  }

  const W = cfg.entryWindow;
  const entry = new Array(n).fill(false), exit = new Array(n).fill(false);
  const exitOnVst = vstActive && (cfg.exit.onVSTBad || !utOn);

  for (let i = 0; i < n; i++) {
    let trigger;
    if (utOn) {
      trigger = false;
      for (let j = 0; j <= W && i - j >= 0; j++) if (ut.buy[i - j]) { trigger = true; break; }
      if (trigger && W > 0) trigger = ut.trendUp[i];       // jangan masuk lagi kalau UT sudah sell
    } else {
      trigger = vstOk[i] && !(i > 0 && vstOk[i - 1]);       // Volume ST saja: entry saat baru menjadi OK
    }
    entry[i] = vstOk[i] && trigger;
    exit[i] = (utOn && cfg.exit.onUTSell && cfg.exit.utKey == null && ut.sell[i]) || (exitOnVst && !vstOk[i]);
  }

  // Sisi SHORT (futures): cermin dari long. Entry = UT sell + Volume ST bearish (syarat sama dengan long, dicerminkan); exit = UT buy.
  const vstShortOk = new Array(n).fill(true);
  if (vstActive) {
    for (let i = 0; i < n; i++) {
      vstShortOk[i] = (!cfg.vst.requireColor || vst.colorBear[i]) && (!cfg.vst.requireDirection || vst.dirBear[i]);
    }
  }
  const shortEntry = new Array(n).fill(false), shortExit = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    let trigger;
    if (utOn) {
      trigger = false;
      for (let j = 0; j <= W && i - j >= 0; j++) if (ut.sell[i - j]) { trigger = true; break; }
      if (trigger && W > 0) trigger = !ut.trendUp[i];
    } else {
      trigger = vstShortOk[i] && !(i > 0 && vstShortOk[i - 1]);
    }
    shortEntry[i] = vstShortOk[i] && trigger;
    shortExit[i] = (utOn && ut.buy[i]) || (!utOn && vstActive && !vstShortOk[i]);
  }

  return { cfg, ut, vst, vstOk, entry, exit, shortEntry, shortExit };
}

// Harga stop loss untuk posisi baru. entryPrice = harga beli, atr = ATR (periode utBot.atr) sebelum entry.
function stopLossPrice(entryPrice, atr, userCfg) {
  const sl = mergeConfig(userCfg).stopLoss;
  if (sl.mode === 'atr' && fin(atr)) return entryPrice - sl.atrMult * atr;
  if (sl.mode === 'percent') return entryPrice * (1 - sl.percent / 100);
  return NaN; // 'off'
}

// Untuk screener: evaluasi candle close TERAKHIR saja
function evaluateLast(candles, userCfg) {
  const s = computeSignals(candles, userCfg);
  const i = candles.length - 1;
  return {
    time: candles[i].time,
    close: candles[i].close,
    entry: s.entry[i],
    exit: s.exit[i],
    atr: s.ut.atr[i],
    stopLoss: stopLossPrice(candles[i].close, s.ut.atr[i], userCfg), // acuan SL kalau entry di harga close ini
    ut: { buy: s.ut.buy[i], sell: s.ut.sell[i], trendUp: s.ut.trendUp[i], stop: s.ut.stop[i] },
    vst: {
      ok: s.vstOk[i],
      colorBull: s.vst.colorBull[i],
      dirBull: s.vst.dirBull[i],
      label: s.vst.label[i],
      superTrend: s.vst.superTrend[i],
    },
  };
}

module.exports = { stopLossPrice, DEFAULT_CONFIG, mergeConfig, computeSignals, evaluateLast, utBot, volumeSuperTrend, rma, trueRange };
