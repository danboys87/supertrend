'use strict';
/**
 * Daftar koin top N dari CoinGecko (gratis), tanpa stablecoin / token wrapped / staked,
 * dicocokkan dengan pair spot XXX-USDT yang live di OKX. Di-cache ke universe.json (default 24 jam).
 * Env opsional: COINGECKO_API_KEY (Demo key gratis; disarankan untuk polling terjadwal).
 */
const fs = require('fs'), path = require('path');

const CG = 'https://api.coingecko.com/api/v3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cg(q) {
  const headers = { accept: 'application/json' };
  if (process.env.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
  const r = await fetch(CG + q, { headers });
  if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`);
  return r.json();
}
const markets = (extra = '') => cg(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1${extra}`);

// Cadangan kalau kategori CoinGecko gagal diambil / tidak lengkap
const STABLE_SYMBOLS = new Set(['usdt', 'usdc', 'dai', 'usde', 'usds', 'usd1', 'fdusd', 'tusd', 'pyusd', 'usdd', 'frax', 'busd', 'gusd', 'usdp', 'lusd', 'susd', 'eurc', 'euri', 'usdg', 'rlusd', 'usdt0', 'bfusd', 'usdf', 'usdc.e']);
const WRAPPED_SYMBOLS = new Set(['wbtc', 'weth', 'steth', 'wsteth', 'reth', 'cbbtc', 'cbeth', 'weeth', 'wbeth', 'beth', 'ezeth', 'rseth', 'wbnb']);
const WRAPPED_NAME = /^(wrapped|bridged)\s|\bstaked\b|\bliquid staking\b/i;

async function okxSpotUsdt() {
  const j = await (await fetch('https://www.okx.com/api/v5/public/instruments?instType=SPOT')).json();
  if (j.code !== '0') throw new Error('OKX instruments: ' + j.msg);
  const map = new Map();
  for (const i of j.data) if (i.quoteCcy === 'USDT' && i.state === 'live') map.set(i.baseCcy.toUpperCase(), i.instId);
  return map;
}

async function build(u, log) {
  const topN = Math.min(Math.max(+u.topN || 150, 1), 250);
  const top = (await markets()).slice(0, topN);

  const idsOf = async (cat) => {
    try { await sleep(2500); return new Set((await markets(`&category=${cat}`)).map((c) => c.id)); }
    catch (e) { log(`Kategori ${cat} gagal (${e.message}), pakai daftar cadangan`); return new Set(); }
  };
  const stable = u.excludeStable ? await idsOf('stablecoins') : new Set();
  const wrapped = u.excludeWrapped ? new Set([...(await idsOf('wrapped-tokens')), ...(await idsOf('liquid-staking-tokens'))]) : new Set();
  const okx = await okxSpotUsdt();

  const stats = { considered: top.length, excludedStable: 0, excludedWrapped: 0, noOkx: 0, duplicates: 0 };
  const seen = new Set(), pairs = [];
  top.forEach((c, i) => {
    const sym = c.symbol.toLowerCase();
    if (u.excludeStable && (stable.has(c.id) || STABLE_SYMBOLS.has(sym))) { stats.excludedStable++; return; }
    if (u.excludeWrapped && (wrapped.has(c.id) || WRAPPED_SYMBOLS.has(sym) || WRAPPED_NAME.test(c.name))) { stats.excludedWrapped++; return; }
    const instId = okx.get(sym.toUpperCase());
    if (!instId) { stats.noOkx++; return; }
    if (seen.has(instId)) { stats.duplicates++; return; } // simbol kembar: ambil yang peringkatnya lebih tinggi
    seen.add(instId);
    pairs.push({ pair: instId, id: c.id, name: c.name, rank: c.market_cap_rank ?? i + 1 });
  });
  return { updated: Date.now(), topN, excludeStable: !!u.excludeStable, excludeWrapped: !!u.excludeWrapped, pairs, stats };
}

async function getUniverse(u, dir, log) {
  const file = path.join(dir, 'universe.json');
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* belum ada */ }
  const topN = Math.min(Math.max(+u.topN || 150, 1), 250);
  const ok = cache && cache.topN === topN && cache.excludeStable === !!u.excludeStable && cache.excludeWrapped === !!u.excludeWrapped
    && Date.now() - cache.updated < (u.refreshHours || 24) * 3600e3;
  if (ok) return cache;
  try {
    const fresh = await build(u, log);
    fs.writeFileSync(file, JSON.stringify(fresh));
    const s = fresh.stats;
    log(`Universe diperbarui: top ${fresh.topN} -> ${fresh.pairs.length} pair OKX (stable ${s.excludedStable}, wrapped/staked ${s.excludedWrapped}, tidak ada di OKX ${s.noOkx})`);
    return fresh;
  } catch (e) {
    log(`Universe gagal diperbarui: ${e.message}${cache ? ' (pakai cache lama)' : ''}`);
    return cache;
  }
}

module.exports = { getUniverse };
