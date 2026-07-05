// =====================================================================
//  hornbach.mjs — Hornbach-Filialbestand BROWSERLOS (oeffentliche
//  GraphQL /frontend/query, operationName=marketModal). Kein Cloudflare,
//  kein Chrome. marketModal ordnet Maerkte PER IP zu -> laeuft der Host
//  am Heimanschluss (Pi/PC), sind es die Filialen in DEINER Naehe.
//  (Auf einem Rechenzentrums-Host sind es die Filialen dort -> daher
//   filtern wir zusaetzlich streng nach HOME-Umkreis.)
//  Rueckgabe im Notifier-Format: { status, avail, note, stores }.
// =====================================================================
import fs from 'node:fs';
import { plzToCoords, haversineKm } from './geo.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const QUERY = fs.readFileSync(new URL('./hornbach_marketModal.gql', import.meta.url), 'utf8');
const QTY_RX = /(\d+)\s*ST/i;

const HOME_PLZ = process.env.PS_HOME_PLZ || process.env.OBI_POSTAL_CODE || '31785';   // Hameln
const RADIUS_KM = parseFloat(process.env.PS_RADIUS_KM || '30');

async function marketModal(abstractProductId) {
  const r = await fetch('https://www.hornbach.de/frontend/query?fitlocale=de-DE&operationName=marketModal', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, origin: 'https://www.hornbach.de' },
    body: JSON.stringify({ operationName: 'marketModal', variables: { input: { abstractProductId } }, query: QUERY }),
  });
  if (r.status !== 200) return { status: r.status, sp: null };
  return { status: 200, sp: (await r.json()).data?.storeAndProduct || null };
}

// s: Quelle mit s.abstractProductId, s.url
export async function probeHornbach(s) {
  const home = plzToCoords(HOME_PLZ);
  const { status, sp } = await marketModal(s.abstractProductId);
  if (status !== 200) return { status, avail: 'unknown', note: 'HTTP ' + status };
  if (!sp) return { status: 200, avail: 'none', note: 'keine Daten (delisted?)' };

  const offers = sp.product?.offerList || [];
  const nearby = sp.store?.nearbyStoreList || [];
  if (!offers.length) return { status: 200, avail: 'none', note: 'kein Angebot (delisted/ausverkauft)' };

  // merchantId -> { ok, qty } aus offerList
  const byMerchant = {};
  for (const o of offers) {
    const txt = o.availabilityText || '';
    const ok = o.supplementaryTextState === 'SUCCESS' || /vorr[aä]tig|verf[uü]gbar/i.test(txt);
    const qty = (txt.match(QTY_RX) || [])[1];
    byMerchant[o.merchantId] = { ok, qty: qty ? +qty : null };
  }

  const stores = [];
  for (const st of nearby) {
    const m = byMerchant[st.merchantId];
    if (!m || !m.ok || !(m.qty > 0)) continue;
    const plz = (st.mainAddress?.addressLine2 || '').match(/\b(\d{5})\b/)?.[1];
    const co = plz ? plzToCoords(plz) : null;
    const km = home && co ? Math.round(haversineKm(home.lat, home.lon, co.lat, co.lon)) : null;
    if (km != null && km > RADIUS_KM) continue;   // ausserhalb HOME-Umkreis -> ignorieren
    stores.push({ name: (st.name || 'Filiale').replace('HORNBACH ', ''), qty: m.qty, km });
  }
  stores.sort((a, b) => (a.km ?? 999) - (b.km ?? 999));

  if (stores.length) return { status: 200, avail: 'store', stores,
    note: `${stores.length} Markt/Maerkte ≤${RADIUS_KM}km: ${stores.slice(0, 4).map(x => `${x.name}${x.km != null ? ' ' + x.km + 'km' : ''}:${x.qty}`).join(', ')}` };
  return { status: 200, avail: 'none', note: `nicht vorraetig im Umkreis (${nearby.length} Filialen geprueft)` };
}
