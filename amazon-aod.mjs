// =====================================================================
//  amazon-aod.mjs — Amazon-Verfuegbarkeit HART ueber die echte
//  Angebotsliste (AOD = All Offers Display), NICHT ueber Katalogdaten.
//
//  Warum: Die PDP zeigt statisch nur Katalog-/Referenzdaten
//  ("IN_STOCK", "Nur noch 3", UVP 599 €) — auch wenn KEIN kaufbares
//  Angebot existiert (Buybox unterdrueckt -> nur "Alle Angebote").
//  Der AOD-Endpunkt liefert die ECHTEN, kaufbaren Angebote mit echtem
//  Preis + Verkaeufer + Versand. Browserlos abrufbar (kein Login).
//
//  Endpunkt (aus Live-Netzwerkmitschnitt):
//    GET /gp/product/ajax/aodAjaxMain/ref=dp_aod_unknown_mbc?asin=<ASIN>&pc=dp
//
//  Ein Alert nur, wenn ein Angebot ALLE Kriterien erfuellt:
//    - kaufbar (In den Einkaufswagen)           -> echtes Angebot, keine Referenz
//    - Zustand NEU                              -> keine Gebraucht/B-Ware
//    - Preis <= maxPrice                        -> Scalper-Schutz auf ECHTEM Preis
//    - (optional) Versand durch Amazon          -> keine dubiosen Drittanbieter
// =====================================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';

function aodUrl(asin) {
  return `https://www.amazon.de/gp/product/ajax/aodAjaxMain/ref=dp_aod_unknown_mbc?asin=${asin}&m=&qid=&smid=&sr=&pc=dp`;
}

const strip = s => (s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// deutschen Preis "1.999" + "00" -> 1999.00
function toNumber(whole, frac) {
  if (whole == null) return null;
  const n = parseFloat(whole.replace(/\./g, '') + '.' + (frac || '0'));
  return Number.isFinite(n) ? n : null;
}

// Wert eines aod-offer-<field>-Blocks: ab der id-Position die naechste
// rechte Spalte (a-col-right) lesen; Label steht in der linken Spalte.
function fieldValue(block, field) {
  const i = block.indexOf(`aod-offer-${field}`);
  if (i < 0) return null;
  const seg = block.slice(i, i + 700);
  // Verkaeufer steht oft als Link; sonst Klartext in der rechten Spalte.
  const right = (seg.match(/a-col-right[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
             || seg.match(/a-col-right[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
  const link = right.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
  return strip(link ? link[1] : right) || null;
}

export function parseAodOffers(html) {
  const offers = [];
  // jeden Angebot-Block isolieren (pinned = Buybox-Gewinner, sonst normale Angebote)
  const re = /id="aod-(pinned-offer|offer)"([\s\S]*?)(?=id="aod-(?:pinned-offer|offer|offerList|sticky)"|<div id="all-offers-display-footer"|$)/g;
  let m;
  while ((m = re.exec(html))) {
    const kind = m[1], block = m[2];
    const whole = (block.match(/a-price-whole[^>]*>([\d.]+)/) || [])[1];
    const frac = (block.match(/a-price-fraction[^>]*>(\d+)/) || [])[1];
    const price = toNumber(whole, frac);
    // Verkaeufer / Versand: Wert der rechten Spalte im jeweiligen Sub-Block
    const soldBy = fieldValue(block, 'soldBy');
    const shipsFrom = fieldValue(block, 'shipsFrom');
    // Zustand: expliziter Block ODER ">Neu<"/"Gebraucht" im Block
    const condRaw = strip((block.match(/aod-offer-condition[\s\S]{0,200}?a-col-right[^>]*>([\s\S]*?)<\/div>/) || [])[1]) || '';
    const isUsed = /gebraucht|generalüberholt|zustand: (gut|akzeptabel|sehr gut)|refurbished|b-ware/i.test(block);
    const cond = isUsed ? 'Gebraucht' : (condRaw || 'Neu');
    const buyable = /In den Einkaufswagen|add-to-cart|aod-atc/i.test(block);
    if (price != null || buyable) offers.push({ kind, price, soldBy, shipsFrom, cond, buyable });
  }
  return offers;
}

// asin: ASIN, maxPrice: Preisdeckel, opts.requireAmazonShip: nur "Versand durch Amazon"
export async function amazonAodAvailability(asin, maxPrice, opts = {}) {
  const { requireAmazonShip = false } = opts;
  let html, status;
  try {
    const r = await fetch(aodUrl(asin), {
      headers: { 'user-agent': UA, 'accept-language': 'de-DE,de;q=0.9', 'x-requested-with': 'XMLHttpRequest', accept: 'text/html,*/*' },
    });
    status = r.status;
    if (status !== 200) return { ok: false, status, avail: 'unknown', note: `AOD HTTP ${status}` };
    html = await r.text();
  } catch (e) { return { ok: false, status: 0, avail: 'unknown', note: 'AOD Fehler ' + e.message }; }

  const offers = parseAodOffers(html);
  const buyable = offers.filter(o => o.buyable && o.price != null);
  const qualifying = buyable.filter(o =>
    o.cond !== 'Gebraucht' &&
    o.price <= maxPrice &&
    (!requireAmazonShip || /amazon/i.test(o.shipsFrom || '') || /amazon/i.test(o.soldBy || ''))
  ).sort((a, b) => a.price - b.price);

  const cheapest = buyable.slice().sort((a, b) => a.price - b.price)[0] || null;
  const best = qualifying[0] || null;

  if (best) {
    return { ok: true, avail: 'online', price: best.price, seller: best.soldBy, shipsFrom: best.shipsFrom,
      offers: offers.length, buyable: buyable.length,
      note: `kaufbar ${best.price.toFixed(2)}€ (${best.soldBy || '?'}${/amazon/i.test(best.shipsFrom || '') ? ', Versand Amazon' : ''})` };
  }
  return { ok: true, avail: 'none', price: cheapest?.price ?? null,
    offers: offers.length, buyable: buyable.length,
    note: buyable.length
      ? `kein Angebot ≤${maxPrice}€ (günstigstes echtes: ${cheapest?.price?.toFixed(2)}€) – kein Alert`
      : 'keine kaufbaren Angebote (nur Referenz/Buybox unterdrückt) – kein Alert' };
}
