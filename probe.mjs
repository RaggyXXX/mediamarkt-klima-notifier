// =====================================================================
//  probe.mjs — liest die Verfuegbarkeit EINER Quelle. Wiederverwendbar
//  (import { probeSource }) + CLI (node probe.mjs [retailer]).
//
//  Rueckgabe: { id, retailer, product, status, avail, price, stores, note }
//    avail: 'online' = online bestellbar | 'store' = im Markt vorraetig
//           'none'   = ausverkauft/404   | 'unknown' = kein klares Signal
// =====================================================================
import { SOURCES } from './sources.mjs';
import { amazonAodAvailability } from './amazon-aod.mjs';
import { probeHagebau } from './hagebau.mjs';
import { probeHornbach } from './hornbach.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---- Standort/Umkreis (einstellbar) ----
// Default: Hameln, 30 km. Marktabholung wird nur gemeldet, wenn eine Filiale
// innerhalb des Umkreises liegt; sonst zaehlt nur Online-Verfuegbarkeit.
export const HOME_PLZ = process.env.PS_HOME_PLZ || process.env.OBI_POSTAL_CODE || '31785';   // Hameln
export const RADIUS_KM = parseFloat(process.env.PS_RADIUS_KM || '30');

// impit lazy laden (nur fuer via:'impit')
let Impit = null, Browser = null, impitClient = null;
async function impitFetch(url) {
  if (!impitClient) {
    ({ Impit, Browser } = await import('impit'));
    impitClient = new Impit({ browser: Browser.Chrome, ignoreTlsErrors: true });
  }
  const r = await impitClient.fetch(url, { headers: { 'Accept-Language': 'de-DE,de;q=0.9', Accept: 'text/html,application/xhtml+xml' } });
  return { status: r.status, body: await r.text() };
}
async function plainFetch(url, accept = 'text/html,application/xhtml+xml') {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'de-DE,de;q=0.9', accept }, redirect: 'follow' });
  return { status: r.status, body: await r.text() };
}

const SCHEMA_RX = /schema\.org\/(InStock|OutOfStock|LimitedAvailability|BackOrder|PreOrder|SoldOut|Discontinued|OnlineOnly|InStoreOnly)/i;
const PRICE_RX = /"price"\s*:\s*"?([0-9]+(?:[.,][0-9]{1,2})?)"?/i;

// Preis robust in Zahl wandeln — auch deutsches Format "1.979,00" und Zahlen.
function parseEuro(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');   // 1.979,00 -> 1979.00
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Preis-Deckel-Gate: ueberteuerte (Scalper-)Angebote NICHT als verfuegbar melden.
function applyPriceGate(s, r) {
  const pn = parseEuro(r.price);
  if (pn != null) r.priceNum = pn;
  if (r.avail === 'online' || r.avail === 'store') {
    if (pn != null && s.maxPrice && pn > s.maxPrice) {
      r.avail = 'overpriced';
      r.note = `überteuert ${pn.toFixed(2)}€ > Limit ${s.maxPrice}€ (Scalper?) – kein Alert`;
    } else if (pn == null && s.retailer === 'Amazon') {
      // Amazon ist scalper-anfaellig -> ohne lesbaren Preis NICHT melden.
      r.avail = 'unknown';
      r.note = 'Preis nicht lesbar (Amazon) – kein Alert ohne Preis-Check';
    }
  }
  return r;
}
const OOS_RX = /nicht (mehr )?verf[uü]gbar|nicht lieferbar|ausverkauft|derzeit nicht|benachrichtige mich|vergriffen|momentan nicht/i;
const INSTOCK_RX = /in den warenkorb|in den einkaufswagen|jetzt kaufen|auf lager|sofort lieferbar|im markt reservieren/i;

function schemaToAvail(s) {
  // InStoreOnly = nur Marktabholung, aber Filiale/Distanz NICHT bekannt (kein OBI-API)
  // -> 'store-remote' (kein Alert; nur OBI kann per-Filiale im Umkreis pruefen).
  if (/^InStoreOnly$/i.test(s)) return 'store-remote';
  if (/^(InStock|LimitedAvailability|BackOrder|PreOrder|OnlineOnly)$/i.test(s)) return 'online';
  return 'none';
}

// ---- OBI: EIN JSON-Call = Online-Lieferung + Filialbestand (Stueckzahl) ----
async function probeObiApi(s) {
  const plz = HOME_PLZ;
  const r = await fetch(`https://www.obi.de/api/pdp/v1/availability/${s.articleId}?postalCode=${plz}`,
    { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (r.status !== 200) return { status: r.status, avail: 'unknown', note: 'HTTP ' + r.status };
  let j = {}; try { j = JSON.parse(await r.text()); } catch {}
  const online = (j.deliveryDataPerSeller || []).length > 0;
  const inStock = (j.pickupStores || []).filter(x => (x.availableQuantity || 0) > 0)
    .map(x => ({ name: (x.pickupName || '').replace('OBI Markt ', ''), qty: x.availableQuantity, price: x.price, km: x.pickupDistance ?? null }));
  const near = inStock.filter(x => x.km != null && x.km <= RADIUS_KM).sort((a, b) => a.km - b.km);
  const price = near[0]?.price || inStock[0]?.price || (j.deliveryDataPerSeller || [])[0]?.price || null;
  // online -> immer; sonst Filiale im Umkreis -> 'store'; sonst Filiale nur weiter weg -> 'store-remote' (kein Alert)
  const avail = online ? 'online' : (near.length ? 'store' : (inStock.length ? 'store-remote' : 'none'));
  const note = online ? 'online lieferbar'
    : near.length ? `${near.length} Filiale(n) ≤${RADIUS_KM}km: ${near.slice(0, 4).map(x => `${x.name} ${x.km}km:${x.qty}`).join(', ')}`
    : inStock.length ? `nur weiter weg (>${RADIUS_KM}km, ${inStock.length} Filialen) – nur online zaehlt`
    : `nichts nahe PLZ ${plz}`;
  return { status: 200, avail, price, stores: near, note };
}

// ---- Amazon: kein zuverlaessiges schema.org -> Buybox-Marker + Buybox-Preis ----
function amazonBuyboxPrice(body) {
  const m = body.match(/corePrice[\s\S]{0,700}?a-offscreen"?\s*>\s*([\d.,]+)\s*(?:€|&#8364;|&euro;|EUR)/i)
        || body.match(/priceToPay[\s\S]{0,400}?a-offscreen"?\s*>\s*([\d.,]+)\s*(?:€|&#8364;)/i)
        || body.match(/a-offscreen"?\s*>\s*([\d.,]+)\s*(?:€|&#8364;|&euro;)/i);
  return m ? m[1] : null;
}
async function probeExpert(s){ const store=s.storeId||"e_2214116"; const r=await fetch(`https://production.brntgs.expert.de/api/pricepds?webcode=${s.webcode}&storeId=${store}`,{headers:{"user-agent":UA,accept:"application/json"}}); if(r.status!==200) return {avail:"none",status:r.status,note:"nicht gelistet (HTTP "+r.status+")"}; let j={};try{j=JSON.parse(await r.text());}catch{} const pr=j.price||{}; const online=pr.onlineButtonAction==="ORDER"||(pr.onlineStock||0)>0; return {avail:online?"online":"none",status:200,price:pr.grossPrice??pr.price??pr.basicPrice??null,note:`online ${pr.onlineStock??"-"} / Filiale ${pr.storeStock??"-"}`}; }

// ---- Galaxus: kein schema.org -> Textmarker (via impit, sonst 403) ----
function galaxusParse(body) {
  if (/nicht (mehr )?lieferbar|nicht verf[uü]gbar|ausverkauft/i.test(body)) return { avail: 'none', note: 'nicht lieferbar' };
  if (/in den warenkorb|sofort lieferbar|lieferbar ab \d|noch \d+ st[uü]ck|an lager/i.test(body)) return { avail: 'online', note: 'lieferbar' };
  return { avail: 'unknown', note: 'kein eindeutiger Galaxus-Marker' };
}

function amazonParse(body) {
  const price = amazonBuyboxPrice(body);
  if (/Derzeit nicht verf[uü]gbar/i.test(body)) return { avail: 'none', price, note: 'Derzeit nicht verfügbar' };
  if (/id="add-to-cart-button"/i.test(body) || /Nur noch \d+ auf Lager/i.test(body) || /\bAuf Lager\./i.test(body))
    return { avail: 'online', price, note: 'kaufbar (add-to-cart)' };
  return { avail: 'unknown', price, note: 'kein eindeutiger Amazon-Marker (pruefen!)' };
}

// ---- Generisch: PDP holen; 404->none, sonst schema.org / OOS-Text / live ----
function htmlParse(status, body) {
  if (status === 404) return { avail: 'none', note: 'PDP 404 (delisted/ausverkauft)' };
  if (status !== 200) return { avail: 'unknown', note: 'HTTP ' + status };
  const price = (body.match(PRICE_RX) || [])[1] || null;
  const schema = (body.match(SCHEMA_RX) || [])[1] || null;
  if (schema) return { avail: schemaToAvail(schema), price, note: 'schema=' + schema };
  if (OOS_RX.test(body)) return { avail: 'none', price, note: 'OOS-Text erkannt' };
  if (INSTOCK_RX.test(body)) return { avail: 'online', price, note: 'Kauf-Marker erkannt' };
  // Seite lebt (200), aber kein klarer Marker -> bei delisting-Ketten ist 200 selbst das Signal.
  return { avail: 'unknown', price, note: 'Seite live, kein klarer Marker (200)' };
}

export async function probeSource(s) {
  const meta = { id: s.id, retailer: s.retailer, product: s.product, url: s.url, via: s.via, tier: s.tier };
  let r;
  try {
    if (s.method === 'obi-api') { r = { ...meta, ...(await probeObiApi(s)) }; }
    else if (s.method === 'hagebau') { r = { ...meta, ...(await probeHagebau(s)) }; }
    else if (s.method === 'hornbach') { r = { ...meta, ...(await probeHornbach(s)) }; }
    else if (s.method === 'expert') { r = { ...meta, ...(await probeExpert(s)) }; }
    else if (s.method === 'amazon') {
      // HART ueber die echte Angebotsliste (AOD) statt Katalogdaten der PDP.
      const asin = s.asin || (s.url.match(/\/dp\/([A-Z0-9]{10})/) || [])[1];
      const a = await amazonAodAvailability(asin, s.maxPrice, { requireAmazonShip: !!s.requireAmazonShip });
      r = { ...meta, status: a.status ?? 200, avail: a.avail, price: a.price ?? null,
            priceNum: a.price ?? null, note: a.note, seller: a.seller, shipsFrom: a.shipsFrom };
      return r;   // AOD hat Preis-/Zustand-/Kaufbarkeits-Gate bereits angewandt
    }
    else {
      const { status, body } = s.via === 'impit' ? await impitFetch(s.url) : await plainFetch(s.url);
      r = s.method === 'amazon' ? { ...meta, status, ...amazonParse(body) }
        : s.method === 'galaxus' ? { ...meta, status, ...galaxusParse(body) }
        : { ...meta, status, ...htmlParse(status, body) };
    }
  } catch (e) {
    return { ...meta, status: 0, avail: 'unknown', note: 'FEHLER ' + e.message };
  }
  return applyPriceGate(s, r);
}

export function isAvailable(avail) { return avail === 'online' || avail === 'store'; }

// ---------------------------- CLI ----------------------------
async function cli() {
  const only = process.argv[2];
  const list = only ? SOURCES.filter(s => s.retailer.toLowerCase() === only.toLowerCase() || s.id.startsWith(only)) : SOURCES;
  const icon = a => ({ online: '🟢 ONLINE', store: '🟡 ABHOLUNG', 'store-remote': '📍 zu weit', none: '⚪ nicht verf.', overpriced: '💸 überteuert', unknown: '❓ unklar' }[a] || '❓');
  console.log('\n=== PortaSplit-Monitor: Verfuegbarkeit ===\n');
  for (const s of list) {
    const r = await probeSource(s);
    console.log(`${icon(r.avail).padEnd(13)} ${r.retailer.padEnd(9)} ${r.product.padEnd(18)} via ${r.via.padEnd(6)} HTTP ${String(r.status).padEnd(4)} ${r.price ? r.price + '€ ' : ''}${r.note}`);
  }
}
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('probe.mjs')) cli();
