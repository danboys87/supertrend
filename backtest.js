'use strict';
/**
 * Backtest perbandingan varian sinyal (spot, long only, 100% equity per trade).
 *
 * Pakai:
 *   node backtest.js data/BTC-USDT-4H.csv
 *   node backtest.js --okx BTC-USDT --bars 3000        (download dari OKX, simpan ke data/)
 *   opsi: --fee 0.001  --window 0  --start 200  --exitkey 3  --sl off|atr:3|pct:8  --slcompare  --trail 15:1[:5]  --trailcompare  --exitcompare
 *
 * Aturan eksekusi (anti lookahead): sinyal dibaca di CLOSE candle i, order terisi di OPEN candle i+1.
 */
const fs = require('fs');
const path = require('path');
const { computeSignals, mergeConfig, rma, trueRange } = require('./strategy');

// ───────────── Data ─────────────
function loadCsv(file) {
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const out = [];
  for (const line of rows) {
    const p = line.split(',');
    if (!Number.isFinite(+p[0])) continue; // skip header
    out.push({ time: +p[0], open: +p[1], high: +p[2], low: +p[3], close: +p[4], volume: +p[5] });
  }
  return out.sort((a, b) => a.time - b.time);
}

function saveCsv(file, candles) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = candles.map((k) => [k.time, k.open, k.high, k.low, k.close, k.volume].join(','));
  fs.writeFileSync(file, ['time,open,high,low,close,volume', ...body].join('\n'));
}

// OKX public API (tanpa API key). Belum diuji dari sandbox saya, cek sekali waktu pertama jalan.
async function fetchOKX(instId, bar = '4H', total = 3000) {
  const out = [];
  let after = '';
  while (out.length < total) {
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=100${after ? `&after=${after}` : ''}`;
    const j = await (await fetch(url)).json();
    if (j.code !== '0') throw new Error(`OKX error: ${j.msg}`);
    if (!j.data.length) break;
    for (const r of j.data) {
      if (r[8] === '1') out.push({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
    }
    after = j.data[j.data.length - 1][0]; // timestamp candle paling lama -> lanjut ke belakang
    await new Promise((r) => setTimeout(r, 150));
  }
  const map = new Map(out.map((k) => [k.time, k]));
  return [...map.values()].sort((a, b) => a.time - b.time);
}

// ───────────── Engine backtest ─────────────
function backtest(candles, cfg, { fee = 0.001, startIdx = 200, trailing = null, collect = null } = {}) {
  const sig = computeSignals(candles, cfg);
  const full = mergeConfig(cfg);
  const exitKey = full.utBot.enabled && full.exit.onUTSell ? full.exit.utKey : null;
  const atrExit = exitKey != null ? rma(trueRange(candles), full.utBot.atr) : null;
  const atrSl = rma(trueRange(candles), full.utBot.atr);
  const slc = full.stopLoss;
  let trail = NaN, slPrice = NaN, slHits = 0;
  // trailing profit-lock (sama dengan screener): aktif saat puncak >= entry +activate%, lalu stop naik ke entry +lock%
  const TR = trailing && trailing.enabled ? trailing : null;
  let hiPx = NaN, entryPx = NaN, trailActive = false, trlAct = 0, trlHits = 0;
  const n = candles.length;
  let cash = 1, units = 0, inPos = false, entryCash = 0, pending = null, barsIn = 0;
  const trades = [];
  const equity = [];

  for (let i = 0; i < n; i++) {
    // 1) eksekusi order yang diputuskan di close candle sebelumnya, harga = open candle ini
    if (pending && i >= startIdx) {
      const px = candles[i].open;
      if (pending === 'buy' && !inPos) {
        entryCash = cash;
        units = (cash * (1 - fee)) / px;
        cash = 0; inPos = true;
        // trailing stop gaya UT (key = exit.utKey), dimulai dari harga entry
        if (exitKey != null) trail = px - exitKey * atrExit[i - 1];
        // stop loss tetap dari harga entry
        slPrice = slc.mode === 'atr' ? px - slc.atrMult * atrSl[i - 1]
                : slc.mode === 'percent' ? px * (1 - slc.percent / 100) : NaN;
        entryPx = px; hiPx = px; trailActive = false;
      } else if (pending === 'sell' && inPos) {
        cash = units * px * (1 - fee);
        trades.push({ ret: cash / entryCash - 1 });
        units = 0; inPos = false;
      }
    }
    pending = null;

    // 1b) stop loss / trailing stop intrabar. Level stop SEBELUM candle ini dicek lebih dulu (konservatif):
    //     kena kalau low <= stop, terisi di stop (atau di open kalau gap turun melewati stop)
    const stopOut = (fillPx) => {
      cash = units * fillPx * (1 - fee);
      trades.push({ ret: cash / entryCash - 1, sl: true, trail: trailActive });
      units = 0; inPos = false; trail = NaN;
      trailActive ? trlHits++ : slHits++;
    };
    if (inPos && Number.isFinite(slPrice) && candles[i].low <= slPrice) stopOut(Math.min(candles[i].open, slPrice));

    // 1c) puncak harga + aktivasi trailing. Stop baru berlaku mulai candle berikutnya, KECUALI candle ini sendiri
    //     ditutup di bawah/pada stop baru (anggap harga sudah melewatinya -> keluar di stop baru).
    if (inPos && TR) {
      hiPx = Math.max(hiPx, candles[i].high);
      const raise = (v) => { if (!Number.isFinite(slPrice) || v > slPrice) slPrice = v; };
      if (!trailActive && hiPx >= entryPx * (1 + TR.activateProfitPct / 100)) {
        raise(entryPx * (1 + TR.lockProfitPct / 100));
        trailActive = true; trlAct++;
      }
      if (trailActive && TR.trailDistancePct != null) raise(hiPx * (1 - TR.trailDistancePct / 100));
      if (trailActive && Number.isFinite(slPrice) && candles[i].close <= slPrice) stopOut(slPrice);
    }

    // 2) mark-to-market di close
    equity.push(inPos ? units * candles[i].close : cash);
    if (inPos) barsIn++;

    // 3) baca sinyal di close, jadwalkan order untuk open berikutnya
    if (i >= startIdx - 1) {
      if (inPos) {
        let sell = sig.exit[i];
        if (exitKey != null) {
          if (candles[i].close < trail) sell = true;                       // close menembus stop sebelumnya
          else trail = Math.max(trail, candles[i].close - exitKey * atrExit[i]); // stop hanya naik
        }
        if (sell) pending = 'sell';
      }
      else if (!inPos && sig.entry[i]) pending = 'buy';
    }
  }
  // posisi yang masih terbuka ditutup di close terakhir (hanya untuk statistik)
  if (inPos) {
    cash = units * candles[n - 1].close * (1 - fee);
    trades.push({ ret: cash / entryCash - 1, open: true });
    equity[n - 1] = cash;
  }

  if (collect) collect.push(...trades);
  const rets = trades.map((t) => t.ret);
  const wins = rets.filter((r) => r > 0), losses = rets.filter((r) => r <= 0);
  const gp = wins.reduce((a, b) => a + b, 0), gl = Math.abs(losses.reduce((a, b) => a + b, 0));
  let peak = -Infinity, maxDD = 0;
  for (let i = startIdx; i < n; i++) {
    peak = Math.max(peak, equity[i]);
    maxDD = Math.max(maxDD, 1 - equity[i] / peak);
  }
  const pct = (x) => +(x * 100).toFixed(2);
  return {
    trades: trades.length,
    slHit: slHits,
    trlAct: trlAct,
    trlHit: trlHits,
    winRate: trades.length ? pct(wins.length / trades.length) : 0,
    totalRet: pct(cash - 1),
    avgTrade: trades.length ? pct(rets.reduce((a, b) => a + b, 0) / trades.length) : 0,
    profitFactor: gl ? +(gp / gl).toFixed(2) : (gp ? Infinity : 0),
    maxDD: pct(maxDD),
    exposure: pct(barsIn / (n - startIdx)),
    buyHold: pct(candles[n - 1].close / candles[startIdx].close - 1),
  };
}

// ───────────── Varian yang dibandingkan ─────────────
// exitKey: null = exit pakai UT sell key entry (lama), angka = trailing stop UT dengan key tsb dari titik entry
function variants(windowN, exitKey) {
  const mk = (utOn, color, dir, ek) => ({
    utBot: { enabled: utOn },
    vst: { requireColor: color, requireDirection: dir },
    entryWindow: windowN,
    exit: { utKey: ek },
  });
  const out = {
    '>> SETTING AKTIF (default config)': { entryWindow: windowN },
    'B. VST saja (warna+arah)': mk(false, true, true, null),
  };
  const defs = [
    ['A. UT saja', true, false, false],
    ['C. UT + VST warna', true, true, false],
    ['D. UT + VST arah', true, false, true],
    ['E. UT + VST warna+arah', true, true, true],
  ];
  for (const [name, u, c, d] of defs) {
    out[`${name} | exit key2`] = mk(u, c, d, null);
    out[`${name} | exit key${exitKey}`] = mk(u, c, d, exitKey);
  }
  return out;
}

// ───────────── Opsi stop loss untuk CLI ─────────────
// --sl off | atr:3 | pct:8   -> dipaksa ke semua baris tabel   |   --slcompare -> bandingkan SL di setting aktif
function parseSL(txt) {
  if (txt === 'off') return { mode: 'off' };
  const [m, v] = txt.split(':');
  if (m === 'atr') return { mode: 'atr', atrMult: +v };
  if (m === 'pct') return { mode: 'percent', percent: +v };
  throw new Error(`--sl tidak dikenal: ${txt} (pakai off | atr:3 | pct:8)`);
}

// --trail 15:1 | 15:1:5 (aktivasi% : kunci% : jarak-trailing%) | off   ->  --trailcompare membandingkan beberapa nilai
function parseTrail(txt) {
  if (txt === 'off') return null;
  const [a, l, d] = txt.split(':').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(l)) throw new Error(`--trail tidak dikenal: ${txt} (pakai 15:1 atau 15:1:5 atau off)`);
  return { enabled: true, activateProfitPct: a, lockProfitPct: l, trailDistancePct: Number.isFinite(d) ? d : null };
}

// ───────────── CLI ─────────────
async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
  const fee = +opt('fee', 0.001), windowN = +opt('window', 0), startIdx = +opt('start', 200), exitKey = +opt('exitkey', 3);

  let candles, label;
  if (args.includes('--okx')) {
    const inst = opt('okx', 'BTC-USDT');
    candles = await fetchOKX(inst, '4H', +opt('bars', 3000));
    saveCsv(path.join('data', `${inst}-4H.csv`), candles);
    label = inst;
  } else {
    const file = args.find((a) => !a.startsWith('--') && fs.existsSync(a));
    if (!file) { console.log('Beri file CSV atau pakai --okx BTC-USDT'); process.exit(1); }
    candles = loadCsv(file); label = path.basename(file);
  }

  console.log(`\n${label} | ${candles.length} candle | fee/sisi ${fee * 100}% | entryWindow ${windowN} | exit key uji ${exitKey}`);
  const table = {};
  const forcedTrail = opt('trail', null) ? parseTrail(opt('trail')) : null;
  if (args.includes('--exitcompare')) {
    // Bandingkan cara keluar di setting entry yang sama: UT sell vs trailing X% dari puncak (dihitung sejak entry)
    const slForce = opt('sl', null);
    const base = (utSell) => ({ entryWindow: windowN, exit: { onUTSell: utSell }, ...(slForce ? { stopLoss: parseSL(slForce) } : {}) });
    const fromEntry = (d) => ({ enabled: true, activateProfitPct: 0, lockProfitPct: -100, trailDistancePct: d }); // tanpa syarat profit
    const rows = [
      ['UT sell saja (acuan sekarang)', base(true), null],
      ['Trailing 5% saja (tanpa UT sell)', base(false), fromEntry(5)],
      ['Trailing 8% saja (tanpa UT sell)', base(false), fromEntry(8)],
      ['Trailing 10% saja (tanpa UT sell)', base(false), fromEntry(10)],
      ['Trailing 12% saja (tanpa UT sell)', base(false), fromEntry(12)],
      ['UT sell + trailing 8% (yang dulu kena)', base(true), fromEntry(8)],
      ['UT sell + trailing 10% (yang dulu kena)', base(true), fromEntry(10)],
      ['UT sell + 15:1:8 (aktif setelah +15%)', base(true), parseTrail('15:1:8')],
    ];
    for (const [name, c, t] of rows) table[name] = backtest(candles, c, { fee, startIdx, trailing: t });
  } else if (args.includes('--trailcompare')) {
    const slForce = opt('sl', null);
    for (const o of ['off', '10:1', '15:1', '20:1', '15:1:5', '15:1:8', '25:1:8']) {
      table[`Trailing ${o}`] = backtest(candles, { entryWindow: windowN, ...(slForce ? { stopLoss: parseSL(slForce) } : {}) }, { fee, startIdx, trailing: parseTrail(o) });
    }
  } else if (args.includes('--slcompare')) {
    const opts = ['off', 'atr:2', 'atr:3', 'atr:4', 'pct:5', 'pct:8', 'pct:10', 'pct:15'];
    for (const o of opts) table[`SL ${o}`] = backtest(candles, { entryWindow: windowN, stopLoss: parseSL(o) }, { fee, startIdx, trailing: forcedTrail });
  } else {
    const forced = opt('sl', null);
    for (const [name, cfg] of Object.entries(variants(windowN, exitKey))) {
      const c = forced ? { ...cfg, stopLoss: parseSL(forced) } : cfg;
      table[name] = backtest(candles, c, { fee, startIdx, trailing: forcedTrail });
    }
  }
  console.table(table);
  console.log('Kolom % : totalRet, avgTrade, winRate, maxDD, exposure, buyHold');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { backtest, loadCsv, fetchOKX, variants };
