// =====================================================================
//  sources.mjs — alle Beobachtungsziele (Produkt x Haendler).
//  URLs empirisch verifiziert 2026-07-02 (aus Live-Discovery + braucheklima-
//  Trackingdaten). tier steuert die Poll-Rate (siehe watcher.mjs).
//
//  NUR die echten Klimaanlagen (PortaSplit + PortaSplit Cool) — KEINE
//  Halterungen/Zubehoer. maxPrice = Preis-Deckel gegen Scalper/Wucher:
//  ueber diesem Preis wird NICHT gemeldet (retail ~749 € / ~599 €).
//
//  method:  'obi-api'  = OBI JSON-API (online + Filialbestand mit Stueckzahl)
//           'amazon'   = Amazon Buybox-Parser
//           'html'     = PDP holen, schema.org / OOS-Text / 404->200 auswerten
//  via:     'fetch' (Node builtin) | 'impit' (Chrome-TLS gegen WAF)
//  tier:    'open' (3-5s) | 'impit' (10-15s) | 'amazon' (30-60s)
// =====================================================================

export const PRODUCTS = ['PortaSplit', 'PortaSplit Cool'];

// Preis-Deckel je Produkt (EUR). Ueber diesem Wert = kein Alert (Scalper-Schutz).
export const MAX_PRICE = { 'PortaSplit': 899, 'PortaSplit Cool': 799 };

export const SOURCES = [
  // ---------- OBI (offen, JSON-API fuer PortaSplit inkl. Filialbestand) ----------
  { id: 'obi:portasplit', retailer: 'OBI', product: 'PortaSplit', tier: 'open',
    method: 'obi-api', via: 'fetch', articleId: '8620890', postalCode: '30159', maxPrice: 899,
    url: 'https://www.obi.de/p/8620890/midea-mobile-split-klimaanlage-portasplit' },
  { id: 'obi:cool', retailer: 'OBI', product: 'PortaSplit Cool', tier: 'open',
    method: 'obi-api', via: 'fetch', articleId: '2191158911022', maxPrice: 799,
    url: 'https://www.obi.de/p/2191158911022/midea-split-klimaanlage-portasplit-cool-mobil-weissgrau' },

  // ---------- Amazon (eigener Parser, konservative Rate; Scalper-anfaellig -> Preis-Deckel!) ----------
  { id: 'amazon:portasplit', retailer: 'Amazon', product: 'PortaSplit', tier: 'amazon',
    method: 'amazon', via: 'fetch', maxPrice: 899, url: 'https://www.amazon.de/dp/B0D3PP64JS' },
  { id: 'amazon:cool', retailer: 'Amazon', product: 'PortaSplit Cool', tier: 'amazon',
    method: 'amazon', via: 'fetch', maxPrice: 799, url: 'https://www.amazon.de/dp/B0GXDWTFR5' },

  // ---------- Bauhaus (impit gegen WAF; PDP schema.org) ----------
  { id: 'bauhaus:portasplit', retailer: 'Bauhaus', product: 'PortaSplit', tier: 'impit',
    method: 'html', via: 'impit', maxPrice: 899, url: 'https://www.bauhaus.info/p/31934233' },
  { id: 'bauhaus:cool', retailer: 'Bauhaus', product: 'PortaSplit Cool', tier: 'impit',
    method: 'html', via: 'impit', maxPrice: 799, url: 'https://www.bauhaus.info/p/33946696' },

  // ---------- Hornbach (offen; aktuell 404 delisted -> 404->200 ist das Signal) ----------
  { id: 'hornbach:portasplit', retailer: 'Hornbach', product: 'PortaSplit', tier: 'open',
    method: 'html', via: 'fetch', maxPrice: 899,
    url: 'https://www.hornbach.de/p/klimasplitgeraet-midea-portasplit-12-000-btu-105-m-weiss/12356554/' },

  // ---------- Toom (offen; aktuell 404 delisted) ----------
  { id: 'toom:portasplit', retailer: 'Toom', product: 'PortaSplit', tier: 'open',
    method: 'html', via: 'fetch', maxPrice: 899,
    url: 'https://www.toom.de/p/mobiles-klimageraet-portasplit-12000-btuh/9350668' },
  { id: 'toom:cool', retailer: 'Toom', product: 'PortaSplit Cool', tier: 'open',
    method: 'html', via: 'fetch', maxPrice: 799,
    url: 'https://www.toom.de/p/split-klimaanlage-portasplit-cool-8000btuh/10515238' },

  // ---------- Hagebau (impit; aktuell 404; Friendly Captcha auf Live-Seite moeglich) ----------
  { id: 'hagebau:portasplit', retailer: 'Hagebau', product: 'PortaSplit', tier: 'impit',
    method: 'html', via: 'impit', maxPrice: 899,
    url: 'https://www.hagebau.de/p/midea-klimaanlage-portasplit-anP7004600334/' },

  // ---------- Globus (impit; aktuell 404) ----------
  { id: 'globus:portasplit', retailer: 'Globus', product: 'PortaSplit', tier: 'impit',
    method: 'html', via: 'impit', maxPrice: 899,
    url: 'https://www.globus-baumarkt.de/p/midea-portasplit-mobile-split-klimaanlage-12000-btu-heiz-kuehlfunktion-0694600235/' },
  { id: 'globus:cool', retailer: 'Globus', product: 'PortaSplit Cool', tier: 'impit',
    method: 'html', via: 'impit', maxPrice: 799,
    url: 'https://www.globus-baumarkt.de/p/midea-portasplit-mobile-split-klimaanlage-cool-8000-btu-kuehlfunktion-0694600251/' },
];
