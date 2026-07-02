// =====================================================================
//  portasplit.mjs — PortaSplit-Watcher als andockbares Modul.
//  Wird von server.js gestartet (startPortaSplit(alertFn)) und laeuft
//  PARALLEL zum Klima-Notifier im selben Prozess. Meldet ueber die
//  uebergebene alert-Funktion (dieselben Telegram/Discord-Kanaele).
//
//  Ziele: sources.mjs · Auswertung: probe.mjs. Zustand in-memory
//  (Render-Free-Disk ist ephemer; nach Redeploy meldet er aktuell
//  Verfuegbares einmal neu — akzeptabel).
// =====================================================================
import { SOURCES } from './sources.mjs';
import { probeSource, isAvailable } from './probe.mjs';

const env = process.env;
const num = (k, d) => Math.max(1, parseInt(env[k] || d, 10));
const CFG = {
  openSec: num('PS_OPEN_SEC', 4),
  impitSec: num('PS_IMPIT_SEC', 12),
  amazonSec: num('PS_AMAZON_SEC', 45),
  jitterPct: num('PS_JITTER_PCT', 30),
  confirmProbes: num('PS_CONFIRM_PROBES', 3),
  confirmGapMs: num('PS_CONFIRM_GAP_MS', 1200),
  goneConfirm: num('PS_GONE_CONFIRM', 3),
};
const TIER_SEC = { open: CFG.openSec, impit: CFG.impitSec, amazon: CFG.amazonSec };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => Math.round(ms * (1 + (Math.random() * 2 - 1) * CFG.jitterPct / 100));
const log = (...a) => console.log('[porta]', ...a);

const state = {};   // id -> { active, avail, goneStreak, lastStatus, lastSeen }
let ALERT = async () => {};

function label(a) { return { online: 'ONLINE bestellbar', store: 'im Markt vorrätig', none: 'ausverkauft', unknown: 'unklar' }[a] || a; }

// Warum meldenswert? avail online/store ODER Seite war 404 und ist jetzt 200 (Restock).
function activeReason(r, prevStatus) {
  if (r.avail === 'online') return 'ONLINE bestellbar';
  if (r.avail === 'store') return 'im Markt vorrätig';
  if (r.status === 200 && prevStatus === 404) return 'Seite wieder online (möglicher Restock – sofort prüfen)';
  return null;
}
const stillActive = (r, prevStatus) => activeReason(r, prevStatus) !== null && r.status !== 404;

async function confirm(s, prevStatus) {
  let lastR = null;
  for (let i = 0; i < CFG.confirmProbes; i++) {
    lastR = await probeSource(s);
    if (!stillActive(lastR, prevStatus)) return { ok: false, r: lastR };
    if (i < CFG.confirmProbes - 1) await sleep(CFG.confirmGapMs);
  }
  return { ok: true, r: lastR };
}

async function handle(s, r) {
  const st = state[s.id] || (state[s.id] = { active: false, avail: 'none', goneStreak: 0, lastStatus: null, lastSeen: null });
  const prevStatus = st.lastStatus;
  const reason = activeReason(r, prevStatus);
  const wasActive = st.active === true;

  if (reason && !wasActive) {
    const c = await confirm(s, prevStatus);
    if (c.ok) {
      st.active = true; st.avail = c.r.avail; st.goneStreak = 0; st.lastSeen = new Date().toISOString();
      const priceStr = c.r.price ? ` — ${c.r.price} €` : '';
      const storeStr = c.r.stores?.length ? `\nFilialen: ${c.r.stores.slice(0, 5).map(x => x.name + ' (' + x.qty + ')').join(', ')}` : '';
      const title = `🌬️ ${s.retailer}: Midea ${s.product} — ${reason}${priceStr}`;
      const message = `${c.r.note}${storeStr}\n⚡ schnell sein – oft in <1 Min wieder weg!`;
      try { await ALERT({ title, message, url: s.url }); } catch (e) { log('alert Fehler:', e.message); }
      log(`>>> MELDUNG: ${s.id} (${reason})${priceStr}`);
    } else { log(`~ ${s.id}: Flacker (Verify negativ)`); }
  } else if (!reason && wasActive) {
    st.goneStreak = (st.goneStreak || 0) + 1;
    if (st.goneStreak >= CFG.goneConfirm) { st.active = false; st.avail = r.avail; log(`<<< ${s.id}: wieder ausverkauft`); }
  } else {
    st.goneStreak = 0;
  }
  st.lastStatus = r.status;
}

async function loopSource(s) {
  const baseMs = (TIER_SEC[s.tier] ?? 8) * 1000;
  await sleep(Math.random() * baseMs);   // Startversatz
  for (;;) {
    try { await handle(s, await probeSource(s)); }
    catch (e) { log(`[!] ${s.id}: ${e.message}`); }
    await sleep(jitter(baseMs));
  }
}

export function startPortaSplit(alertFn) {
  if (typeof alertFn === 'function') ALERT = alertFn;
  log(`gestartet: ${SOURCES.length} Quellen (open ${CFG.openSec}s / impit ${CFG.impitSec}s / amazon ${CFG.amazonSec}s)`);
  SOURCES.forEach(s => loopSource(s));
}

export function getPortaSnapshot() {
  return SOURCES.map(s => {
    const st = state[s.id] || {};
    return { id: s.id, retailer: s.retailer, product: s.product, url: s.url,
      active: !!st.active, avail: st.avail || 'none', lastStatus: st.lastStatus ?? null, lastSeen: st.lastSeen || null };
  });
}
