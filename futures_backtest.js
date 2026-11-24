'use strict';
/**
 * Backtest FUTURES (USDT-M perpetual) dengan candle Bitget: timeframe bebas (default 1H), long dan/atau short, leverage,
 * likuidasi (isolated), fee, funding, stop loss ATR, trailing, dan filter kondisi pasar BTC (opsional).
 *
 *   node futures_backtest.js --symbols BTCUSDT,ETHUSDT,SOLUSDT --bar 1H --bars 9000 --lev 1,3,5
 *   node futures_backtest.js --universe --top 50 --part 1/3 --bars 9000      (HANYA unduh sepertiga daftar; ulangi 2/3, 3/3)
 *   node futures_backtest.js --universe --top 50 --bars 9000 --regime utvst
 *
 * Opsi: --lev 1,3 (leverage)  --margin 0.33 (porsi ekuitas yang dipakai sebagai margin per trade)  --fee 0.0006 (taker per sisi, % dari nilai posisi)
 *       --funding 0.0001 (biaya funding per 8 jam, dianggap DIBAYAR kedua sisi = konservatif)  --trail 15:1 | 15:1:8 | off  --window 0
 *       --regime off|sma200|ut2|utvst  --ref BTCUSDT  --detail  --refresh  --dir data  --start 200
 * Setiap koin disimulasikan SENDIRI-SENDIRI (tanpa batas slot/ranking). Aturan: sinyal di close, order terisi di open candle berikutnya.
 * Sinyal short = cermin sinyal long (UT sell + Volume ST bearish). Parameter indikator MASIH hasil tuning 4H spot, belum disesuaikan untuk 1H.
 */
const fs = require('fs'), path = require('path');
const { computeSignals, utBot, rma, trueRange } = require('./strategy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAR_MS = { '15m': 9e5, '30m': 1.8e6, '1H': 3.6e6, '4H': 1.44e7 };
const MMR = 0.005; // perkiraan maintenance margin rate untuk harga likuidasi (aproksimasi, bukan rumus resmi Bitget)

// ───────────── Data (Bitget USDT-M, endpoint publik tanpa API key) ─────────────
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
// history-candles: maks 200 candle per request, urut mundur memakai endTime (sesuai dokumentasi Bitget v2)
async function fetchBitget(symbol, bar, total) {
  const out = [];
  let end = Date.now();
  while (out.length < total) {
    const url = `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${bar}&endTime=${end}&limit=200`;
    let j;
    for (let a = 0; ; a++) {
      try { j = await (await fetch(url)).json(); if (j.code !== '00000') throw new Error(j.msg || j.code); break; }
      catch (e) { if (a >= 2) throw e; await sleep(1000 * (a + 1)); }
    }
    const rows = j.data || [];
    if (!rows.length) break;
    for (const r of rows) out.push({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
    const oldest = Math.min(...rows.map((r) => +r[0]));
    if (oldest >= end) break;
    end = oldest;
    await sleep(150);
  }
  const ms = BAR_MS[bar];
  return [...new Map(out.map((k) => [k.time, k])).values()].sort((a, b) => a.time - b.time).filter((k) => k.time + ms <= Date.now()); // buang candle yang belum close
}
const fileOf = (dir, symbol, bar) => path.join(dir, `${symbol}-${bar}-bitget.csv`);
const metaOf = (dir, symbol, bar) => path.join(dir, `${symbol}-${bar}-bitget.meta.json`);
function needsDownload(symbol, bar, bars, dir, refresh) {
  if (refresh || !fs.existsSync(fileOf(dir, symbol, bar))) return true;
  let req = 0; try { req = JSON.parse(fs.readFileSync(metaOf(dir, symbol, bar), 'utf8')).requested; } catch { /* tanpa catatan */ }
  return req < bars;
}
async function getCandles(symbol, bar, bars, dir, refresh) {
  if (!needsDownload(symbol, bar, bars, dir, refresh)) return loadCsv(fileOf(dir, symbol, bar));
  try {
    const c = await fetchBitget(symbol, bar, bars);
    if (c.length) { saveCsv(fileOf(dir, symbol, bar), c); fs.writeFileSync(metaOf(dir, symbol, bar), JSON.stringify({ requested: bars, got: c.length })); }
    return c;
  } catch (e) { if (fs.existsSync(fileOf(dir, symbol, bar))) return loadCsv(fileOf(dir, symbol, bar)); throw e; }
}

// ───────────── Filter kondisi pasar (acuan BTC) ─────────────
function buildRegime(key, ref) {
  const n = ref.length, cl = ref.map((k) => k.close);
  const ut = utBot(ref, { key: 2, atr: 10 }).trendUp;
  const vs = computeSignals(ref, { entryWindow: 0 }).vst;
  const long = new Array(n).fill(false), short = new Array(n).fill(false);
  let run = 0;
  for (let i = 0; i < n; i++) {
    run += cl[i]; if (i >= 200) run -= cl[i - 200];
    if (i < 200) continue;
    if (key === 'sma200') { long[i] = cl[i] > run / 200; short[i] = cl[i] < run / 200; }
    else if (key === 'ut2') { long[i] = ut[i]; short[i] = !ut[i]; }
    else if (key === 'utvst') { long[i] = ut[i] && vs.dirBull[i]; short[i] = !ut[i] && vs.dirBear[i]; }
  }
  return { t: ref.map((k) => k.time), long, short };
}
function align(reg, candles) { // carry-forward kondisi acuan terakhir ke tiap candle koin
  const L = new Array(candles.length).fill(true), S = new Array(candles.length).fill(true);
  if (!reg) return { L, S };
  let q = 0, l = false, s = false;
  candles.forEach((k, i) => { while (q < reg.t.length && reg.t[q] <= k.time) { l = reg.long[q]; s = reg.short[q]; q++; } L[i] = l; S[i] = s; });
  return { L, S };
}

// ───────────── Simulasi satu koin ─────────────
function simulate(c, sig, atr, mode, o) {
  const { lev, marginFrac, fee, funding, barH, trail, startIdx, gate } = o;
  const slc = sig.cfg.stopLoss, n = c.length;
  let eq = 1, pos = null, pendExit = false, pendEntry = null, peak = 1, maxDD = 0, barsIn = 0, liqN = 0, slN = 0, trlN = 0, fundingPaid = 0;
  const trades = [];
  const fin = Number.isFinite;

  const closePos = (px, why) => {
    const dir = pos.side === 'long' ? 1 : -1;
    const exitNotional = pos.notional * (px / pos.entryPx);
    let pnl = dir * (px / pos.entryPx - 1) * pos.notional - pos.entryFee - exitNotional * fee - pos.funding;
    if (why === 'Likuidasi') pnl = -pos.margin;
    pnl = Math.max(pnl, -pos.margin); // isolated: rugi maksimal = margin
    eq += pnl; fundingPaid += pos.funding;
    trades.push({ side: pos.side, pnl, why });
    if (why === 'Likuidasi') liqN++; else if (why === 'Stop loss') slN++; else if (why === 'Trailing stop') trlN++;
    pos = null;
  };
  const openPos = (side, px, i) => {
    const margin = eq * marginFrac, notional = margin * lev, a = atr[i - 1];
    const sl = slc.mode === 'atr' && fin(a) ? (side === 'long' ? px - slc.atrMult * a : px + slc.atrMult * a)
      : slc.mode === 'percent' ? (side === 'long' ? px * (1 - slc.percent / 100) : px * (1 + slc.percent / 100)) : NaN;
    pos = { side, entryPx: px, margin, notional, entryFee: notional * fee, funding: 0, sl, ext: px, trailActive: false,
      liq: side === 'long' ? px * (1 - 1 / lev + MMR) : px * (1 + 1 / lev - MMR) };
  };

  for (let i = 0; i < n; i++) {
    const k = c[i];
    // 1) order dari close sebelumnya terisi di open
    if (i >= startIdx) {
      if (pendExit && pos) closePos(k.open, 'Sinyal');
      if (pendEntry && !pos && eq > 1e-9) openPos(pendEntry, k.open, i);
    }
    pendExit = false; pendEntry = null;

    if (pos) {
      const long = pos.side === 'long';
      // 2) stop loss / likuidasi intrabar (level lama dicek dulu)
      const stop = long ? Math.max(fin(pos.sl) ? pos.sl : -Infinity, pos.liq) : Math.min(fin(pos.sl) ? pos.sl : Infinity, pos.liq);
      const liqBinds = long ? pos.liq >= (fin(pos.sl) ? pos.sl : -Infinity) : pos.liq <= (fin(pos.sl) ? pos.sl : Infinity);
      if (long ? k.low <= stop : k.high >= stop) {
        closePos(long ? Math.min(k.open, stop) : Math.max(k.open, stop), liqBinds ? 'Likuidasi' : pos.trailActive ? 'Trailing stop' : 'Stop loss');
      } else if (trail) {
        // 3) puncak harga, aktivasi trailing (ukuran = pergerakan HARGA, bukan ROE), stop mengikuti puncak
        pos.ext = long ? Math.max(pos.ext, k.high) : Math.min(pos.ext, k.low);
        const raise = (v) => { if (!fin(pos.sl) || (long ? v > pos.sl : v < pos.sl)) pos.sl = v; };
        const reached = long ? pos.ext >= pos.entryPx * (1 + trail.activate / 100) : pos.ext <= pos.entryPx * (1 - trail.activate / 100);
        if (!pos.trailActive && reached) { raise(pos.entryPx * (1 + (long ? 1 : -1) * trail.lock / 100)); pos.trailActive = true; }
        if (pos.trailActive && trail.dist != null) raise(long ? pos.ext * (1 - trail.dist / 100) : pos.ext * (1 + trail.dist / 100));
        if (pos.trailActive && fin(pos.sl) && (long ? k.close <= pos.sl : k.close >= pos.sl)) closePos(pos.sl, 'Trailing stop');
      }
    }
    if (pos) { pos.funding += pos.notional * funding * (barH / 8); barsIn++; }

    // 4) nilai akun (mark-to-market) untuk drawdown
    if (i >= startIdx) {
      let m = eq;
      if (pos) m += (pos.side === 'long' ? 1 : -1) * (k.close / pos.entryPx - 1) * pos.notional - pos.entryFee - pos.funding;
      peak = Math.max(peak, m); maxDD = Math.max(maxDD, 1 - m / peak);
    }

    // 5) sinyal di close
    if (i >= startIdx - 1) {
      const gl = gate.L[i], gs = gate.S[i];
      if (pos) {
        if (pos.side === 'long') {
          if (sig.exit[i]) pendExit = true;
          if (mode === 'both' && sig.shortEntry[i] && gs) { pendExit = true; pendEntry = 'short'; } // balik arah
        } else {
          if (sig.shortExit[i]) pendExit = true;
          if (mode === 'both' && sig.entry[i] && gl) { pendExit = true; pendEntry = 'long'; }
        }
      } else if (mode !== 'short' && sig.entry[i] && gl) pendEntry = 'long';
      else if (mode !== 'long' && sig.shortEntry[i] && gs) pendEntry = 'short';
    }
  }
  if (pos) closePos(c[n - 1].close, 'Akhir data');

  const w = trades.filter((t) => t.pnl > 0), gp = w.reduce((a, t) => a + t.pnl, 0), gl2 = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  return {
    trades: trades.length, longs: trades.filter((t) => t.side === 'long').length, shorts: trades.filter((t) => t.side === 'short').length,
    winRate: trades.length ? (w.length / trades.length) * 100 : 0, totalRet: (eq - 1) * 100, pf: gl2 ? gp / gl2 : gp ? Infinity : 0,
    maxDD: maxDD * 100, liq: liqN, sl: slN, trl: trlN, exposure: (barsIn / (n - startIdx)) * 100,
    buyHold: (c[n - 1].close / c[startIdx].close - 1) * 100, fundingPaid: fundingPaid * 100,
  };
}
function prep(candles, cfg) {
  const sig = computeSignals(candles, cfg);
  return { candles, sig, atr: rma(trueRange(candles), sig.cfg.utBot.atr) };
}

// ───────────── Ringkasan ─────────────
const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r2 = (v) => (Number.isFinite(v) ? +v.toFixed(2) : v);
function summarize(rs) {
  const pf = rs.map((r) => r.pf).filter(Number.isFinite);
  return {
    koin: rs.length, trades: rs.reduce((a, r) => a + r.trades, 0), long: rs.reduce((a, r) => a + r.longs, 0), short: rs.reduce((a, r) => a + r.shorts, 0),
    winRate: r2(avg(rs.map((r) => r.winRate))), retRata2: r2(avg(rs.map((r) => r.totalRet))), retMedian: r2(med(rs.map((r) => r.totalRet))),
    koinUntung: r2((rs.filter((r) => r.totalRet > 0).length / rs.length) * 100), pfRata2: r2(avg(pf)), ddRata2: r2(avg(rs.map((r) => r.maxDD))),
    likuidasi: rs.reduce((a, r) => a + r.liq, 0), stopLoss: rs.reduce((a, r) => a + r.sl, 0), bhRata2: r2(avg(rs.map((r) => r.buyHold))),
  };
}

// ───────────── CLI ─────────────
async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const dir = opt('dir', 'data'), bar = opt('bar', '1H'), bars = +opt('bars', 9000), refresh = args.includes('--refresh');
  if (!BAR_MS[bar]) { console.log(`--bar tidak dikenal: ${bar} (pakai ${Object.keys(BAR_MS).join(', ')})`); return; }
  const levs = opt('lev', '1,3').split(',').map(Number), marginFrac = +opt('margin', 0.33), fee = +opt('fee', 0.0006), funding = +opt('funding', 0.0001);
  const startIdx = +opt('start', 200), windowN = +opt('window', 0), regimeKey = opt('regime', 'off'), ref = opt('ref', 'BTCUSDT');
  const tr = opt('trail', '15:1');
  const trail = tr === 'off' ? null : (([a, l, d]) => ({ activate: a, lock: l, dist: Number.isFinite(d) ? d : null }))(tr.split(':').map(Number));

  let symbols;
  if (opt('symbols', null)) symbols = opt('symbols').split(',').map((s) => s.trim().toUpperCase());
  else if (args.includes('--universe')) {
    const uf = path.join(dir, 'universe.json');
    if (!fs.existsSync(uf)) { console.log(`Tidak ada ${uf}. Jalankan screener sekali, atau pakai --symbols BTCUSDT,ETHUSDT`); return; }
    let list = JSON.parse(fs.readFileSync(uf, 'utf8')).pairs;
    if (opt('top', null)) list = list.filter((x) => x.rank <= +opt('top'));
    symbols = list.map((x) => x.pair.replace('-', ''));
  } else { console.log('Beri --symbols BTCUSDT,ETHUSDT atau --universe [--top 50]'); return; }

  const part = opt('part', null);
  if (part) {
    const [pi, pn] = part.split('/').map(Number);
    if (!(pi >= 1 && pn >= 1 && pi <= pn)) { console.log('Format --part salah, contoh: --part 1/3'); return; }
    const a = Math.floor(((pi - 1) * symbols.length) / pn), b = Math.floor((pi * symbols.length) / pn), sub = symbols.slice(a, b);
    console.log(`Bagian ${pi}/${pn}: koin ke-${a + 1} s/d ${b} dari ${symbols.length} (hanya mengunduh, ${bar}, ${bars} candle)`);
    for (let n = 0; n < sub.length; n++) {
      process.stdout.write(`[${n + 1}/${sub.length}] ${sub[n]} ... `);
      try { console.log(`${(await getCandles(sub[n], bar, bars, dir, refresh)).length} candle`); } catch (e) { console.log('gagal: ' + e.message); }
    }
    console.log(pi < pn ? `\nLanjut: node futures_backtest.js ${args.filter((x) => x !== part && x !== '--part').join(' ')} --part ${pi + 1}/${pn}` : '\nSemua bagian selesai. Jalankan tanpa --part untuk backtest.');
    return;
  }
  const need = symbols.filter((s) => needsDownload(s, bar, bars, dir, refresh)).length;
  if (need) console.log(`Perlu mengunduh ${need} koin (kira-kira ${Math.max(1, Math.round((need * (bars / 200) * 0.35) / 60))} menit). Bisa dibagi dengan --part 1/3\n`);

  let reg = null;
  if (regimeKey !== 'off') {
    const rc = await getCandles(ref, bar, bars, dir, false);
    if (rc.length < 300) { console.log(`Data acuan ${ref} kurang.`); return; }
    reg = buildRegime(regimeKey, rc);
  }

  const coins = [];
  for (let n = 0; n < symbols.length; n++) {
    process.stdout.write(`[${n + 1}/${symbols.length}] ${symbols[n]} ... `);
    try {
      const c = await getCandles(symbols[n], bar, bars, dir, refresh);
      if (c.length < startIdx + 300) { console.log(`dilewati (${c.length} candle)`); continue; }
      coins.push({ symbol: symbols[n], ...prep(c, { entryWindow: windowN }), gate: align(reg, c) });
      console.log(`${c.length} candle`);
    } catch (e) { console.log('gagal: ' + e.message); }
  }
  if (!coins.length) { console.log('Tidak ada data.'); return; }

  const days = Math.round((Math.max(...coins.map((c) => c.candles.at(-1).time)) - Math.min(...coins.map((c) => c.candles[0].time))) / 864e5);
  console.log(`\n${coins.length} koin | ${bar} | rentang data terpanjang ${days} hari | fee ${fee * 100}%/sisi | funding ${funding * 100}%/8j (dibayar kedua sisi) | margin ${marginFrac * 100}% ekuitas | trailing ${tr} | filter ${regimeKey}${regimeKey !== 'off' ? ' (' + ref + ')' : ''}`);
  console.log('Catatan: tiap koin disimulasikan sendiri; parameter indikator = hasil tuning 4H spot; likuidasi = aproksimasi.');

  const summary = {}, detail = {};
  for (const lev of levs) {
    for (const [label, mode] of [['Long saja', 'long'], ['Short saja', 'short'], ['Long + Short', 'both']]) {
      const rs = coins.map((c) => simulate(c.candles, c.sig, c.atr, mode, { lev, marginFrac, fee, funding, barH: BAR_MS[bar] / 3.6e6, trail, startIdx, gate: c.gate }));
      summary[`${label} x${lev}`] = summarize(rs);
      if (args.includes('--detail') || coins.length <= 6) rs.forEach((r, i) => { detail[`${coins[i].symbol} | ${label} x${lev}`] = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, r2(v)])); });
    }
  }
  console.table(summary);
  if (Object.keys(detail).length) { console.log('\nPer koin:'); console.table(detail); }
  console.log('Kolom: retRata2/retMedian = return % per koin (akun terpisah), koinUntung = % koin yang untung, pfRata2 = profit factor rata-rata, ddRata2 = drawdown rata-rata %, likuidasi = jumlah posisi terlikuidasi, bhRata2 = buy&hold rata-rata %.');
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { simulate, prep, buildRegime, align, getCandles, fetchBitget, needsDownload };
