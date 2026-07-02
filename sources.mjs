// =====================================================================
//  sources.mjs — alle Beobachtungsziele (Produkt x Haendler).
//  URLs empirisch verifiziert 2026-07-02 (aus Live-Discovery + braucheklima-
//  Trackingdaten). tier steuert die Poll-Rate (siehe watcher.mjs).
//
//  method:  'obi-api'  = OBI JSON-API (online + Filialbestand mit Stueckzahl)
//           'amazon'   = Amazon Buybox-Parser
//           'html'     = PDP holen, schema.org / OOS-Text / 404->200 auswerten
//  via:     'fetch' (Node builtin) | 'impit' (Chrome-TLS gegen WAF)
//  tier:    'open' (3-5s) | 'impit' (10-15s) | 'amazon' (30-60s)
// =====================================================================

export const PRODUCTS = ['PortaSplit', 'PortaSplit Cool', 'Universalhalterung'];

export const SOURCES = [
  // ---------- OBI (offen, JSON-API fuer PortaSplit inkl. Filialbestand) ----------
  { id: 'obi:portasplit', retailer: 'OBI', product: 'PortaSplit', tier: 'open',
    method: 'obi-api', via: 'fetch', articleId: '8620890', postalCode: '30159',
    url: 'https://www.obi.de/p/8620890/midea-mobile-split-klimaanlage-portasplit' },
  { id: 'obi:cool', retailer: 'OBI', product: 'PortaSplit Cool', tier: 'open',
    method: 'html', via: 'fetch',
    url: 'https://www.obi.de/p/2191158911022/midea-split-klimaanlage-portasplit-cool-mobil-weissgrau' },
  { id: 'obi:halterung', retailer: 'OBI', product: 'Universalhalterung', tier: 'open',
    method: 'html', via: 'fetch',
    url: 'https://www.obi.de/p/9306093/midea-universalhalterung-fuer-klimaanlage-portasplit-weiss' },

  // ---------- Amazon (eigener Parser, konservative Rate) ----------
  { id: 'amazon:portasplit', retailer: 'Amazon', product: 'PortaSplit', tier: 'amazon',
    method: 'amazon', via: 'fetch', url: 'https://www.amazon.de/dp/B0D3PP64JS' },
  { id: 'amazon:cool', retailer: 'Amazon', product: 'PortaSplit Cool', tier: 'amazon',
    method: 'amazon', via: 'fetch', url: 'https://www.amazon.de/dp/B0GXDWTFR5' },
  { id: 'amazon:halterung', retailer: 'Amazon', product: 'Universalhalterung', tier: 'amazon',
    method: 'amazon', via: 'fetch', url: 'https://www.amazon.de/dp/B0DBW6R17N' },

  // ---------- Bauhaus (impit gegen WAF; PDP schema.org) ----------
  { id: 'bauhaus:portasplit', retailer: 'Bauhaus', product: 'PortaSplit', tier: 'impit',
    method: 'html', via: 'impit', url: 'https://www.bauhaus.info/p/31934233' },
  { id: 'bauhaus:cool', retailer: 'Bauhaus', product: 'PortaSplit Cool', tier: 'impit',
    method: 'html', via: 'impit', url: 'https://www.bauhaus.info/p/33946696' },
  { id: 'bauhaus:halterung', retailer: 'Bauhaus', product: 'Universalhalterung', tier: 'impit',
    method: 'html', via: 'impit', url: 'https://www.bauhaus.info/p/31900492' },

  // ---------- Hornbach (offen; aktuell 404 delisted -> 404->200 ist das Signal) ----------
  { id: 'hornbach:portasplit', retailer: 'Hornbach', product: 'PortaSplit', tier: 'open',
    method: 'html', via: 'fetch',
    url: 'https://www.hornbach.de/p/klimasplitgeraet-midea-portasplit-12-000-btu-105-m-weiss/12356554/' },
  { id: 'hornbach:halterung', retailer: 'Hornbach', product: 'Universalhalterung', tier: 'open',
    method: 'html', via: 'fetch',
    url: 'https://www.hornbach.de/p/midea-universal-halterung-fuer-porta-split/12348122/' },

  // ---------- Toom (offen; aktuell 404 delisted) ----------
  { id: 'toom:portasplit', retailer: 'Toom', product: 'PortaSplit', tier: 'open',
    method: 'html', via: 'fetch',
    url: 'https://www.toom.de/p/mobiles-klimageraet-portasplit-12000-btuh/9350668' },
  { id: 'toom:cool', retailer: 'Toom', product: 'PortaSplit Cool', tier: 'open',
    method: 'html', via: 'fetch',
    url: 'https://www.toom.de/p/split-klimaanlage-portasplit-cool-8000btuh/10515238' },
  { id: 'toom:halterung', retailer: 'Toom', product: 'Universalhalterung', tier: 'open',
    method: 'html', via: 'fetch',
    url: 'https://www.toom.de/p/universalhalterung-fuer-klimageraet-porta-split/9350692' },

  // ---------- Hagebau (impit; aktuell 404; Friendly Captcha auf Live-Seite moeglich) ----------
  { id: 'hagebau:portasplit', retailer: 'Hagebau', product: 'PortaSplit', tier: 'impit',
    method: 'html', via: 'impit',
    url: 'https://www.hagebau.de/p/midea-klimaanlage-portasplit-anP7004600334/' },

  // ---------- Globus (impit; aktuell 404) ----------
  { id: 'globus:portasplit', retailer: 'Globus', product: 'PortaSplit', tier: 'impit',
    method: 'html', via: 'impit',
    url: 'https://www.globus-baumarkt.de/p/midea-portasplit-mobile-split-klimaanlage-12000-btu-heiz-kuehlfunktion-0694600235/' },
  { id: 'globus:cool', retailer: 'Globus', product: 'PortaSplit Cool', tier: 'impit',
    method: 'html', via: 'impit',
    url: 'https://www.globus-baumarkt.de/p/midea-portasplit-mobile-split-klimaanlage-cool-8000-btu-kuehlfunktion-0694600251/' },
];
