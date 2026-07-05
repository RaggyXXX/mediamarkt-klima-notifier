// =====================================================================
//  hagebau.mjs — Hagebau-Filialbestand BROWSERLOS via App-Backend.
//  Reverse-engineered aus der Hagebau-App (de.hagebau.shop):
//    POST https://www.hagebau.de/app-api/products/stock
//         Body {"companyId":"<Markt-ID>","itemId":"<num. Artikel-ID>"}
//    -> data.itemAvailabilityCode: AVAILABLE | SOLD_OUT | NOT_LISTED
//       data.stock (int), data.onlineStock, data.price
//  KEIN API-Key noetig. 460 Maerkte (companyId + Koordinaten) gebundelt.
//  itemId != anP-Nr der URL -> aus der PDP aufloesen ("itemId":"NNNN").
//  Rueckgabe im Notifier-Format: { status, avail, price, note, stores }.
// =====================================================================
import { HAGEBAU_STORES } from './hagebau-stores.mjs';
import { haversineKm, plzToCoords } from './geo.mjs';

const UA = 'Mozilla/5.0 (Linux; Android 14) hagebau-app';
const STOCK_URL = 'https://www.hagebau.de/app-api/products/stock';

const HOME_PLZ = process.env.PS_HOME_PLZ || process.env.OBI_POSTAL_CODE || '31785';   // Hameln
const RADIUS_KM = parseFloat(process.env.PS_RADIUS_KM || '30');
const MAX_STORES = parseInt(process.env.HAGEBAU_MAX_STORES || '40', 10);

async function resolveItemId(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'de-DE,de;q=0.9' }, redirect: 'follow' });
  if (r.status !== 200) return { status: r.status, itemId: null };
  const html = await r.text();
  const itemId = (html.match(/"itemId":"(\d+)"/) || html.match(/"sku":"(\d+)"/) || [])[1] || null;
  return { status: 200, itemId };
}

async function stockAt(companyId, itemId) {
  try {
    const r = await fetch(STOCK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA, accept: 'application/json' },
      body: JSON.stringify({ companyId, itemId }),
    });
    if (r.status !== 200) return null;
    return (await r.json())?.data || null;
  } catch { return null; }
}

// s: Quelle mit s.url (PDP), s.maxPrice
export async function probeHagebau(s) {
  const home = plzToCoords(HOME_PLZ);
  const { status, itemId } = await resolveItemId(s.url);
  if (status === 404) return { status: 404, avail: 'none', note: 'PDP 404 (delisted/ausverkauft)' };
  if (status !== 200) return { status, avail: 'unknown', note: 'HTTP ' + status };
  if (!itemId) return { status: 200, avail: 'none', note: 'Seite live, keine itemId (nicht gelistet)' };

  const near = (home
    ? HAGEBAU_STORES.filter(x => haversineKm(home.lat, home.lon, x.lat, x.lon) <= RADIUS_KM)
    : HAGEBAU_STORES).slice(0, MAX_STORES);

  const stores = [];
  let online = false, price = null;
  for (const st of near) {
    const d = await stockAt(st.id, itemId);
    if (!d) continue;
    if ((d.onlineStock || 0) > 0) online = true;
    if (price == null && d.price) price = d.price;
    if (d.itemAvailabilityCode === 'AVAILABLE') {
      stores.push({ name: st.name, qty: d.stock ?? '?', km: home ? Math.round(haversineKm(home.lat, home.lon, st.lat, st.lon)) : null });
    }
  }
  stores.sort((a, b) => (a.km ?? 999) - (b.km ?? 999));

  if (online) return { status: 200, avail: 'online', price, note: `online lieferbar${stores.length ? ` + ${stores.length} Markt/Maerkte` : ''}`, stores };
  if (stores.length) return { status: 200, avail: 'store', price, stores,
    note: `${stores.length} Markt/Maerkte ≤${RADIUS_KM}km: ${stores.slice(0, 4).map(x => `${x.name} ${x.km}km:${x.qty}`).join(', ')}` };
  return { status: 200, avail: 'none', price, note: `nicht verfuegbar (${near.length} Maerkte ≤${RADIUS_KM}km geprueft)` };
}
