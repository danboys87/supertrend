'use strict';
/**
 * Backtest PORTOFOLIO: banyak koin sekaligus, maksimal N posisi, membandingkan aturan ranking
 * saat sinyal BUY lebih banyak dari slot yang tersedia.
 *
 *   node portfolio.js                              (universe dari data/universe.json, 3 posisi, 3000 candle 4H)
 *   node portfolio.js --top 100 --bars 3000 --maxpos 3,5
 *   node portfolio.js --part 1/3 --bars 9000      (HANYA unduh sepertiga daftar koin, lalu selesai; ulangi 2/3 dan 3/3)
 *   node portfolio.js --pairs HYPE-USDT,ETH-USDT,SOL-USDT --trail 15:1:8
 *
 * Filter kondisi pasar (hanya blok ENTRY baru; posisi terbuka tetap dikelola seperti biasa):
 *   --regime off|ut2|ut3|vst|utvst|sma200  --ref BTC-USDT   |   --regimecompare membandingkan semuanya
 * Opsi: --maxpos 3 (boleh daftar: 3,5,7)  --trail 15:1 | 15:1:8 | off (default 15:1, sama dengan bot)
 *       --minvol 0 (syarat volume 24 jam USDT)  --fee 0.001  --refresh (unduh ulang)  --dir data  --seeds 5
 * Data candle diunduh dari OKX sekali lalu disimpan sebagai CSV di folder data (dipakai ulang).
 *
 * Aturan eksekusi: sinyal di CLOSE candle, order terisi di OPEN candle berikutnya; tiap posisi = ekuitas / maxpos.
 * CATATAN: daftar koin = top CoinGecko HARI INI, jadi ada survivorship bias (koin yang gagal/turun tidak ikut).
 */
const fs = require('fs'), path = require('path');
const { computeSignals, rma, trueRange, utBot } = require('./strategy');

// ───────────── Data ─────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function loadCsv(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)) {
    const p = line.split(',');
    if (Number.isFinite(+p[0])) out.push({ time: +p[0], open: +p[1], high: +p[2], low: +p[3], close: +p[4], volume: +p[5] });
  }
  return out.sort((a, b) => a.time - b.time);
}
function saveCsv(file, candles) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ['time,open,high,low,close,volume', ...candles.map((k) => [k.time, k.open, k.high, k.low, k.close, k.volume].join(','))].join('\n'));
}
async function fetchOKX(instId, total) {
  const out = [];
  let after = '';
  while (out.length < total) {
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=4H&limit=100${after ? `&after=${after}` : ''}`;
    let j;
    for (let a = 0; ; a++) {
      try { j = await (await fetch(url)).json(); if (j.code !== '0') throw new Error(j.msg); break; }
      catch (e) { if (a >= 2) throw e; await sleep(1000 * (a + 1)); }
    }
    if (!j.data.length) break;
    for (const r of j.data) if (r[8] === '1') out.push({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
    after = j.data[j.data.length - 1][0];
    await sleep(150);
  }
  return [...new Map(out.map((k) => [k.time, k])).values()].sort((a, b) => a.time - b.time);
}
const metaFile = (dir, pair) => path.join(dir, `${pair}-4H.meta.json`);
// perlu unduh kalau: --refresh, file belum ada, atau file lama diunduh dengan --bars lebih kecil dari yang diminta sekarang
function needsDownload(pair, bars, dir, refresh) {
  if (refresh || !fs.existsSync(path.join(dir, `${pair}-4H.csv`))) return true;
  let req = 3000; // file lama tanpa catatan dianggap hasil unduhan default 3000
  try { req = JSON.parse(fs.readFileSync(metaFile(dir, pair), 'utf8')).requested; } catch { /* tanpa catatan */ }
  return req < bars;
}
async function getCandles(pair, bars, dir, refresh) {
  const file = path.join(dir, `${pair}-4H.csv`);
  if (!needsDownload(pair, bars, dir, refresh)) return loadCsv(file);
  try {
    const c = await fetchOKX(pair, bars);
    if (c.length) { saveCsv(file, c); fs.writeFileSync(metaFile(dir, pair), JSON.stringify({ requested: bars, got: c.length })); }
    return c;
  } catch (e) {
    if (fs.existsSync(file)) return loadCsv(file); // gagal unduh: pakai file lama kalau ada
    throw e;
  }
}

// ───────────── Persiapan per koin ─────────────
const WARM = 200;
function prep(pair, rank, candles, stratCfg) {
  const sig = computeSignals(candles, stratCfg);
  const atr = rma(trueRange(candles), sig.cfg.utBot.atr);
  const idx = new Map(candles.map((k, i) => [k.time, i]));
  return {
    pair, rank, sig, atr, idx, t: candles.map((k) => k.time),
    o: candles.map((k) => k.open), h: candles.map((k) => k.high), l: candles.map((k) => k.low), cl: candles.map((k) => k.close), v: candles.map((k) => k.volume),
  };
}
const metrics = (c, i) => {
  let v24 = 0; for (let j = Math.max(0, i - 5); j <= i; j++) v24 += c.cl[j] * c.v[j]; // volume 24 jam (6 candle 4H) dalam USDT
  let m = 0, n = 0; for (let j = Math.max(0, i - 20); j < i; j++) { m += c.v[j]; n++; }
  return { vol24: v24, surge: n && m ? c.v[i] / (m / n) : 0, risk: c.atr[i] / c.cl[i] };
};

// ───────────── Aturan ranking (urutan terkecil = dipilih dulu) ─────────────
function seededRand(seed) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); }
const RULES = {
  'Market cap (sekarang)': (cs) => cs.sort((a, b) => a.c.rank - b.c.rank),
  'Volume 24 jam terbesar': (cs) => cs.sort((a, b) => b.m.vol24 - a.m.vol24 || a.c.rank - b.c.rank),
  'Lonjakan volume': (cs) => cs.sort((a, b) => b.m.surge - a.m.surge || a.c.rank - b.c.rank),
  'Risiko terendah (ATR/harga)': (cs) => cs.sort((a, b) => a.m.risk - b.m.risk || a.c.rank - b.c.rank),
  'Skor gabungan (lonjakan+risiko)': (cs) => {
    const rk = (key, dir) => { const s = [...cs].sort((a, b) => dir * (a.m[key] - b.m[key])); s.forEach((x, r) => { x['r_' + key] = r; }); };
    rk('surge', -1); rk('risk', 1);
    return cs.sort((a, b) => (a.r_surge + a.r_risk) - (b.r_surge + b.r_risk) || a.c.rank - b.c.rank);
  },
};

// ───────────── Filter kondisi pasar (acuan: BTC) ─────────────
// Entry baru hanya boleh kalau kondisi acuan OK pada close candle sinyal.
const REGIMES = [
  ['Tanpa filter', 'off'], ['BTC UT naik (key 2)', 'ut2'], ['BTC UT naik (key 3)', 'ut3'],
  ['BTC VST arah bullish', 'vst'], ['BTC UT + VST bullish', 'utvst'], ['BTC di atas SMA200', 'sma200'],
];
function buildRegime(key, c) {
  const n = c.length, cl = c.map((k) => k.close);
  const ut2 = utBot(c, { key: 2, atr: 10 }).trendUp, ut3 = utBot(c, { key: 3, atr: 10 }).trendUp;
  const vst = computeSignals(c, { entryWindow: 0 }).vst.dirBull;
  const ok = new Array(n).fill(false);
  let run = 0;
  for (let i = 0; i < n; i++) {
    run += cl[i]; if (i >= 200) run -= cl[i - 200];
    ok[i] = key === 'ut2' ? ut2[i] : key === 'ut3' ? ut3[i] : key === 'vst' ? vst[i] : key === 'utvst' ? ut2[i] && vst[i]
      : key === 'sma200' ? i >= 199 && cl[i] > run / 200 : true;
  }
  return { t: c.map((k) => k.time), ok };
}

// ───────────── Simulasi portofolio ─────────────
function simulate(coins, rankFn, o) {
  const { maxPos, fee, trail, minVol } = o;
  const times = [...new Set(coins.flatMap((c) => c.t))].sort((a, b) => a - b);
  let cash = 1, lastEq = 1, peak = 1, maxDD = 0, slotSum = 0, signals = 0, skipped = 0, blocked = 0;
  let regOk = null; // kondisi pasar per timestamp (carry-forward dari candle acuan terakhir)
  if (o.regime) { regOk = new Map(); let q = 0, cur = false; for (const T of times) { while (q < o.regime.t.length && o.regime.t[q] <= T) { cur = o.regime.ok[q]; q++; } regOk.set(T, cur); } }
  const pos = new Map(), pend = new Map(), trades = [];

  const close = (pair, px, T, why) => {
    const p = pos.get(pair); const proceeds = p.units * px * (1 - fee);
    cash += proceeds; pos.delete(pair);
    trades.push({ pair, ret: proceeds / p.cost - 1, pnl: proceeds - p.cost, why });
  };

  for (const T of times) {
    const bars = [];
    for (const c of coins) { const i = c.idx.get(T); if (i !== undefined) bars.push([c, i]); }

    // 1) order dari close sebelumnya terisi di open
    for (const [c, i] of bars) {
      const what = pend.get(c.pair); if (!what) continue;
      pend.delete(c.pair);
      if (what === 'buy' && !pos.has(c.pair)) {
        const size = Math.min(cash, lastEq / maxPos); if (size <= 1e-9) continue;
        const px = c.o[i], a = c.atr[i - 1], sl = c.sig.cfg.stopLoss;
        pos.set(c.pair, {
          c, units: (size * (1 - fee)) / px, cost: size, entryPx: px, hi: px, trailActive: false, lastCl: px,
          sl: sl.mode === 'atr' && Number.isFinite(a) ? px - sl.atrMult * a : sl.mode === 'percent' ? px * (1 - sl.percent / 100) : NaN,
        });
        cash -= size;
      } else if (what === 'sell' && pos.has(c.pair)) close(c.pair, c.o[i], T, 'UT sell');
    }

    // 2) stop loss / trailing intrabar (level lama dicek dulu, sama seperti backtest.js)
    for (const [c, i] of bars) {
      const p = pos.get(c.pair); if (!p) continue;
      if (Number.isFinite(p.sl) && c.l[i] <= p.sl) { close(c.pair, Math.min(c.o[i], p.sl), T, p.trailActive ? 'Trailing stop' : 'Stop loss'); continue; }
      if (!trail) continue;
      p.hi = Math.max(p.hi, c.h[i]);
      const raise = (v) => { if (!Number.isFinite(p.sl) || v > p.sl) p.sl = v; };
      if (!p.trailActive && p.hi >= p.entryPx * (1 + trail.activate / 100)) { raise(p.entryPx * (1 + trail.lock / 100)); p.trailActive = true; }
      if (p.trailActive && trail.dist != null) raise(p.hi * (1 - trail.dist / 100));
      if (p.trailActive && Number.isFinite(p.sl) && c.cl[i] <= p.sl) close(c.pair, p.sl, T, 'Trailing stop');
    }

    // 3) nilai portofolio di close
    let eq = cash;
    for (const [pair, p] of pos) { const i = p.c.idx.get(T); if (i !== undefined) p.lastCl = p.c.cl[i]; eq += p.units * p.lastCl; }
    lastEq = eq; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, 1 - eq / peak); slotSum += pos.size / maxPos;

    // 4) sinyal di close: exit posisi, kumpulkan kandidat entry, ranking, isi slot
    const cands = [];
    for (const [c, i] of bars) {
      if (i < WARM) continue;
      if (pos.has(c.pair)) { if (c.sig.exit[i]) pend.set(c.pair, 'sell'); }
      else if (c.sig.entry[i] && !pend.has(c.pair)) {
        if (regOk && !regOk.get(T)) { blocked++; continue; } // filter kondisi pasar
        const m = metrics(c, i);
        if (m.vol24 >= minVol) { cands.push({ c, i, m }); signals++; }
      }
    }
    const pendingBuys = [...pend.values()].filter((x) => x === 'buy').length;
    const slots = Math.max(0, maxPos - pos.size - pendingBuys);
    if (cands.length) {
      const ordered = rankFn(cands);
      ordered.slice(0, slots).forEach((x) => pend.set(x.c.pair, 'buy'));
      skipped += Math.max(0, cands.length - slots);
    }
  }
  for (const pair of [...pos.keys()]) close(pair, pos.get(pair).lastCl, times.at(-1), 'akhir data');

  const w = trades.filter((t) => t.pnl > 0), gp = w.reduce((a, t) => a + t.pnl, 0), gl = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  return {
    trades: trades.length, winRate: trades.length ? (w.length / trades.length) * 100 : 0, totalRet: (cash - 1) * 100,
    avgTrade: trades.length ? (trades.reduce((a, t) => a + t.ret, 0) / trades.length) * 100 : 0,
    profitFactor: gl ? gp / gl : gp ? Infinity : 0, maxDD: maxDD * 100, slotUse: (slotSum / times.length) * 100, signals, skipped, blocked,
  };
}
function avgRandom(coins, o, seeds) {
  const rs = [];
  for (let s = 1; s <= seeds; s++) {
    const rnd = seededRand(s * 7919);
    rs.push(simulate(coins, (cs) => { for (let i = cs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cs[i], cs[j]] = [cs[j], cs[i]]; } return cs; }, o));
  }
  const avg = {};
  for (const k of Object.keys(rs[0])) avg[k] = rs.reduce((a, r) => a + (Number.isFinite(r[k]) ? r[k] : 0), 0) / rs.length;
  return avg;
}
const fmt = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number.isFinite(v) ? +v.toFixed(2) : v]));

// ───────────── CLI ─────────────
async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const dir = opt('dir', 'data'), bars = +opt('bars', 3000), fee = +opt('fee', 0.001), minVol = +opt('minvol', 0), seeds = +opt('seeds', 5);
  const maxList = opt('maxpos', '3').split(',').map(Number);
  const tr = opt('trail', '15:1');
  const trail = tr === 'off' ? null : (([a, l, d]) => ({ activate: a, lock: l, dist: Number.isFinite(d) ? d : null }))(tr.split(':').map(Number));

  // daftar pair + peringkat market cap
  let list;
  if (opt('pairs', null)) list = opt('pairs').split(',').map((p, i) => ({ pair: p.trim(), rank: i + 1 }));
  else {
    const uf = path.join(dir, 'universe.json');
    if (!fs.existsSync(uf)) { console.log(`Tidak ada ${uf}. Jalankan screener sekali (mode coingecko) atau pakai --pairs HYPE-USDT,ETH-USDT,...`); process.exit(1); }
    list = JSON.parse(fs.readFileSync(uf, 'utf8')).pairs.map((x) => ({ pair: x.pair, rank: x.rank }));
    if (opt('top', null)) list = list.filter((x) => x.rank <= +opt('top'));
  }

  const refresh = args.includes('--refresh');
  const part = opt('part', null); // "1/3" = koin ke-1 sampai sepertiga pertama daftar (berurutan menurut peringkat)
  if (part) {
    const [pi, pn] = part.split('/').map(Number);
    if (!(pi >= 1 && pn >= 1 && pi <= pn)) { console.log('Format --part salah, contoh: --part 1/3'); return; }
    const a = Math.floor(((pi - 1) * list.length) / pn), b = Math.floor((pi * list.length) / pn);
    const sub = list.slice(a, b);
    console.log(`Bagian ${pi}/${pn}: koin ke-${a + 1} s/d ${b} dari ${list.length} (hanya mengunduh, tanpa simulasi)`);
    for (let n = 0; n < sub.length; n++) {
      process.stdout.write(`[${n + 1}/${sub.length}] ${sub[n].pair} ... `);
      try { const c = await getCandles(sub[n].pair, bars, dir, refresh); console.log(`${c.length} candle`); } catch (e) { console.log('gagal: ' + e.message); }
    }
    console.log(pi < pn ? `\nSelesai. Lanjut: node portfolio.js --part ${pi + 1}/${pn} --bars ${bars}` : `\nSemua bagian selesai. Jalankan backtest: node portfolio.js --maxpos 3 --bars ${bars}`);
    return;
  }
  const need = list.filter((x) => needsDownload(x.pair, bars, dir, refresh)).length;
  if (need) console.log(`Perlu mengunduh ${need} koin (kira-kira ${Math.max(1, Math.round((need * bars) / 100 * 0.3 / 60))} menit). Bisa dibagi: node portfolio.js --part 1/3 --bars ${bars}\n`);

  const coins = [];
  for (let n = 0; n < list.length; n++) {
    const { pair, rank } = list[n];
    process.stdout.write(`[${n + 1}/${list.length}] ${pair} ... `);
    try {
      const candles = await getCandles(pair, bars, dir, refresh);
      if (candles.length < WARM + 100) { console.log(`dilewati (${candles.length} candle)`); continue; }
      coins.push(prep(pair, rank, candles, {}));
      console.log(`${candles.length} candle`);
    } catch (e) { console.log('gagal: ' + e.message); }
  }
  if (coins.length < 2) { console.log('Data kurang dari 2 koin.'); return; }
  const t0 = Math.min(...coins.map((c) => c.t[0])), t1 = Math.max(...coins.map((c) => c.t.at(-1)));
  const d = (t) => new Date(t).toISOString().slice(0, 10);
  console.log(`\n${coins.length} koin | ${d(t0)} s/d ${d(t1)} | fee/sisi ${fee * 100}% | trailing ${tr} | minvol ${minVol} USDT | filter ${opt('regime', 'off')}`);
  console.log('Peringatan: koin dipilih dari top CoinGecko HARI INI (survivorship bias).');

  // acuan kondisi pasar
  const refPair = opt('ref', 'BTC-USDT'), rk = opt('regime', 'off');
  let refCandles = null;
  if (rk !== 'off' || args.includes('--regimecompare')) {
    const hit = coins.find((c) => c.pair === refPair);
    refCandles = hit ? loadCsv(path.join(dir, `${refPair}-4H.csv`)) : await getCandles(refPair, bars, dir, false);
    if (!refCandles || refCandles.length < 300) { console.log(`Data acuan ${refPair} tidak cukup.`); return; }
  }

  if (args.includes('--regimecompare')) {
    const picks = [['Market cap', RULES['Market cap (sekarang)']], ['Skor gabungan', RULES['Skor gabungan (lonjakan+risiko)']]];
    for (const maxPos of maxList) {
      const table = {};
      for (const [rname, key] of REGIMES) {
        const o = { maxPos, fee, trail, minVol, regime: key === 'off' ? null : buildRegime(key, refCandles) };
        for (const [pn, fn] of picks) table[`${rname} | ${pn}`] = fmt(simulate(coins, fn, o));
        table[`${rname} | Acak (${seeds}x)`] = fmt(avgRandom(coins, o, seeds));
      }
      console.log(`\n=== Perbandingan filter kondisi pasar (acuan ${refPair}), maks ${maxPos} posisi ===`);
      console.table(table);
    }
    console.log('blocked = sinyal BUY yang ditolak filter. Bandingkan tiap filter dengan "Tanpa filter" pada aturan ranking yang sama.');
    return;
  }

  for (const maxPos of maxList) {
    const o = { maxPos, fee, trail, minVol, regime: rk === 'off' ? null : buildRegime(rk, refCandles) };
    const table = {};
    for (const [name, fn] of Object.entries(RULES)) table[name] = fmt(simulate(coins, fn, o));
    table[`Acak (rata-rata ${seeds}x)`] = fmt(avgRandom(coins, o, seeds));
    console.log(`\n=== Maks ${maxPos} posisi ===`);
    console.table(table);
  }
  console.log('Kolom: totalRet, avgTrade, winRate, maxDD, slotUse = rata-rata slot terisi (%), signals = sinyal BUY, skipped = sinyal tidak kebagian slot');
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { simulate, prep, RULES, getCandles, needsDownload };
