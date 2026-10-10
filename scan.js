// /api/scan?mint=<pump.fun CA>
// Vercel Node serverless function. Best-effort read of a pump.fun coin:
// dev (creator) wallet, bundle cluster (buyers in the creation slot + next 2 slots),
// snipers (next slots), top holders with % of supply. Partial data is returned with flags.

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BUDGET_MS = 8000;
const SIG_PAGES = 5;
const TX_CAP = 24;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const mint = String((req.query && req.query.mint) || "").trim();
  if (!B58.test(mint)) {
    res.status(400).json({ error: "mint must be a base58 address (32–44 chars)" });
    return;
  }
  const KEY = process.env.HELIUS_API_KEY;
  if (!KEY) {
    res.status(500).json({ error: "HELIUS_API_KEY is not set" });
    return;
  }
  const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
  const started = Date.now();
  const left = () => Math.max(250, BUDGET_MS - (Date.now() - started));

  const out = {
    mint, symbol: null, name: null, dev: null, feeWallet: null,
    cluster: [], snipers: [], top: [],
    supply: null, creationSlot: null,
    flags: {}, partial: false, source: "live"
  };

  async function fetchJson(url, init, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.min(ms, left()));
    try {
      const r = await fetch(url, { ...init, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async function rpc(method, params, ms = 4000) {
    const j = await fetchJson(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    }, ms);
    if (j.error) throw new Error(j.error.message || "rpc error");
    return j.result;
  }

  // 1. pump.fun public coin endpoint (creator, symbol, name, pool accounts)
  let poolAccounts = new Set();
  try {
    const c = await fetchJson(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      headers: { accept: "application/json" }
    }, 3500);
    if (c && typeof c === "object") {
      out.dev = c.creator || null;
      out.feeWallet = c.creator || null;
      out.symbol = c.symbol || null;
      out.name = c.name || null;
      for (const k of ["bonding_curve", "associated_bonding_curve", "raydium_pool", "pump_swap_pool"]) {
        if (c[k]) poolAccounts.add(c[k]);
      }
      if (c.complete) out.flags.graduated = true;
    }
  } catch (e) {
    out.flags.pumpApiUnavailable = true;
    out.partial = true;
  }

  // 2. supply + top holders (run together)
  const supplyP = rpc("getTokenSupply", [mint]).then(r => {
    out.supply = Number(r.value.uiAmount ?? (Number(r.value.amount) / 10 ** r.value.decimals));
  }).catch(() => { out.flags.supplyUnavailable = true; out.partial = true; });

  const holdersP = rpc("getTokenLargestAccounts", [mint]).then(async r => {
    const accts = (r.value || []).slice(0, 20);
    if (!accts.length) return;
    const info = await rpc("getMultipleAccounts", [accts.map(a => a.address), { encoding: "jsonParsed" }]);
    const rows = [];
    (info.value || []).forEach((acc, i) => {
      const p = acc && acc.data && acc.data.parsed && acc.data.parsed.info;
      if (!p) return;
      const owner = p.owner;
      const amt = Number(p.tokenAmount.uiAmount ?? 0);
      const isPool = poolAccounts.has(accts[i].address) || poolAccounts.has(owner);
      rows.push({ wallet: owner, tokenAccount: accts[i].address, amount: amt, pool: isPool });
    });
    out._rows = rows;
  }).catch(() => { out.flags.holdersUnavailable = true; out.partial = true; });

  // 3. earliest signatures → creation slot → cluster + snipers
  const clusterP = (async () => {
    let before, last = null, pages = 0, reachedEnd = false;
    let earliest = [];
    while (pages < SIG_PAGES && left() > 1200) {
      const sigs = await rpc("getSignaturesForAddress", [mint, { limit: 1000, ...(before ? { before } : {}) }], 3500);
      pages++;
      if (!sigs || !sigs.length) { reachedEnd = true; break; }
      earliest = sigs;
      last = sigs[sigs.length - 1];
      before = last.signature;
      if (sigs.length < 1000) { reachedEnd = true; break; }
    }
    if (!earliest.length) { out.flags.noHistory = true; return; }
    if (!reachedEnd) { out.flags.creationNotReached = true; out.partial = true; return; }
    const creationSlot = last.slot;
    out.creationSlot = creationSlot;
    // signatures are newest-first; take those in the creation window
    const inWindow = earliest.filter(s => s.slot >= creationSlot && s.slot <= creationSlot + 2 && !s.err);
    const sniperWindow = earliest.filter(s => s.slot > creationSlot + 2 && s.slot <= creationSlot + 10 && !s.err);
    const want = inWindow.slice(-TX_CAP).concat(sniperWindow.slice(-Math.max(0, TX_CAP - inWindow.length)));
    if (inWindow.length > TX_CAP) { out.flags.clusterTruncated = true; out.partial = true; }
    const cluster = new Set(), snipers = new Set();
    const txs = await Promise.all(want.map(s => rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], 3000).catch(() => null)));
    txs.forEach((tx, i) => {
      if (!tx || !tx.transaction) return;
      const keys = tx.transaction.message.accountKeys || [];
      const signers = keys.filter(k => k.signer).map(k => typeof k === "string" ? k : k.pubkey);
      const slot = want[i].slot;
      for (const w of signers) {
        if (!w || w === out.dev) continue;
        if (slot <= creationSlot + 2) cluster.add(w); else snipers.add(w);
      }
      // the creator is the fee payer of the creation tx if pump.fun api was down
      if (!out.dev && slot === creationSlot && signers[0]) out.dev = signers[0];
    });
    out._cluster = [...cluster];
    out._snipers = [...snipers];
  })().catch(() => { out.flags.historyUnavailable = true; out.partial = true; });

  const all = Promise.all([supplyP, holdersP, clusterP]);
  const timer = new Promise(r => setTimeout(() => r("timeout"), left()));
  const which = await Promise.race([all.then(() => "done"), timer]);
  if (which === "timeout") { out.flags.timeout = true; out.partial = true; }

  // assemble percentages
  const pct = a => (out.supply ? +(a / out.supply * 100).toFixed(2) : null);
  const held = new Map();
  for (const r of out._rows || []) if (!r.pool) held.set(r.wallet, (held.get(r.wallet) || 0) + r.amount);
  if (out._rows && out._rows.some(r => r.pool)) out.flags.poolExcluded = true;
  out.top = [...held.entries()]
    .filter(([w]) => w !== out.dev)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([wallet, amount]) => ({ wallet, pct: pct(amount) }));
  out.cluster = (out._cluster || []).map(w => ({ wallet: w, pct: held.has(w) ? pct(held.get(w)) : 0 }));
  out.snipers = (out._snipers || []).map(w => ({ wallet: w, pct: held.has(w) ? pct(held.get(w)) : 0 }));
  if (out.dev) out.devPct = held.has(out.dev) ? pct(held.get(out.dev)) : 0;
  delete out._rows; delete out._cluster; delete out._snipers;

  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
  res.status(200).json(out);
}
