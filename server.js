// =====================================================================
//  MediaMarkt -> Telegram Verfuegbarkeits-Notifier  (Render Free tauglich)
// ---------------------------------------------------------------------
//  - 0 Dependencies (nur Node-Builtins: http + global fetch)
//  - prueft per einfachem HTML-Fetch den Liefer-Status
//  - schickt Telegram-Nachricht beim Wechsel ausverkauft -> verfuegbar
//  - Endpoints:
//      GET /         -> Health/Status (kein Check)
//      GET /check    -> fuehrt Pruefung aus (von externem Cron aufrufen)
//      GET /getchatid-> zeigt Chat-IDs aus den letzten Bot-Nachrichten
//
//  Konfiguration via Umgebungsvariablen (in Render -> Environment):
//      BOT_TOKEN, CHAT_ID, PRODUCT_URL, SKU, SOLD_OUT_MARKER ...
// =====================================================================
import http from 'node:http';

const env = process.env;
const PORT            = env.PORT || 10000;                 // Render setzt PORT automatisch
const BOT_TOKEN       = env.BOT_TOKEN || '';
const CHAT_ID         = env.CHAT_ID || '';
const PRODUCT_URL     = env.PRODUCT_URL ||
  'https://www.mediamarkt.de/de/product/_ok-oac-7022-w-klimagerat-weiss-max-raumgrosse-67-m-2763143.html';
const SKU             = env.SKU || '2763143';
const SOLD_OUT_MARKER = env.SOLD_OUT_MARKER || 'mms-cofr-delivery_NOT_AVAILABLE';
const IN_STOCK_MARKER = env.IN_STOCK_MARKER || 'mms-cofr-delivery_AVAILABLE';   // positiver Marker
const A2C_MARKER      = env.A2C_MARKER      || 'cofr-add-to-basket-button';     // Warenkorb-Button
const BLOCKED_MARKER  = env.BLOCKED_MARKER  || 'Reference&#32;ID';
const INTERVAL_MIN    = Math.max(1, parseInt(env.CHECK_INTERVAL_MIN || '10', 10));
// Anti-Fehlalarm: MediaMarkt liefert sporadisch abweichende HTML-Varianten.
// Erst benachrichtigen, wenn N Abrufe IN FOLGE "verfuegbar" zeigen.
const CONFIRM_PROBES  = Math.max(1, parseInt(env.CONFIRM_PROBES || '3', 10));
const CONFIRM_GAP_MS  = Math.max(500, parseInt(env.CONFIRM_GAP_MS || '2500', 10));
// Mindestabstand zwischen zwei "verfuegbar"-Meldungen (gegen Spam bei Geflacker)
const NOTIFY_COOLDOWN_MS = Math.max(0, parseInt(env.NOTIFY_COOLDOWN_MIN || '30', 10))*60*1000;
let lastAvailNotify = 0;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let wasAvailable = false;     // nur bei Wechsel benachrichtigen (Anti-Spam)
let last = null;
let errStreak = 0;

async function tg(text){
  if(!BOT_TOKEN || !CHAT_ID){ console.log('[tg] BOT_TOKEN/CHAT_ID fehlt – haette gesendet:', text); return; }
  try{
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ chat_id: CHAT_ID, text })
    });
    if(!r.ok) console.log('[tg] HTTP', r.status, await r.text());
  }catch(e){ console.log('[tg] Fehler', e.message); }
}

const sleep = ms => new Promise(r=>setTimeout(r,ms));

// EIN Abruf -> Klassifikation
// WICHTIG: KEIN Cache-Busting! Die normale (CDN-gecachte) Seite gibt den
// stabilen, korrekten Status (10/10 getestet, = was du im Browser siehst).
// Cache-Busting wuerde eine optimistische Origin-Variante holen (Fehlalarm).
async function probe(){
  let status=0, html='';
  try{
    const r = await fetch(PRODUCT_URL,{ headers:{
      'user-agent':UA, 'accept-language':'de-DE,de;q=0.9'
    }});
    status = r.status; html = await r.text();
  }catch(e){ html=''; }
  const sane    = html.includes(SKU);
  const blocked = html.includes(BLOCKED_MARKER);
  const soldOut = html.includes(SOLD_OUT_MARKER);
  const inStock = html.includes(IN_STOCK_MARKER) && html.includes(A2C_MARKER); // positiv!
  const pageOk  = status===200 && sane && !blocked;
  // verfuegbar = positiver Marker vorhanden UND kein Ausverkauft-Marker
  const available = pageOk && inStock && !soldOut;
  return { status, sane, blocked, soldOut, inStock, pageOk, available };
}

async function check(){
  let p = await probe();

  // Bestaetigung gegen Cache-Varianten: erst wenn mehrere Abrufe in Folge
  // "verfuegbar" zeigen, gilt es wirklich als verfuegbar.
  let confirms = p.available ? 1 : 0;
  if(p.available){
    for(let i=1;i<CONFIRM_PROBES;i++){
      await sleep(CONFIRM_GAP_MS);
      const q = await probe();
      if(q.available) confirms++; else { p = q; break; }
    }
  }
  const available = confirms >= CONFIRM_PROBES;

  last = { time:new Date().toISOString(), ...p, confirms, confirmNeeded:CONFIRM_PROBES, available };
  console.log('[check]', JSON.stringify(last));

  if(!p.pageOk){
    errStreak++;
    if(errStreak===5) await tg(`⚠️ Notifier bekommt keine sauberen Antworten (HTTP ${p.status}, sane=${p.sane}, blocked=${p.blocked}). Prüfe PRODUCT_URL/SKU.`);
  } else {
    errStreak=0;
    if(available && !wasAvailable){
      await tg(`🟢 VERFÜGBAR! Die Klimaanlage ist jetzt lieferbar (${confirms}/${CONFIRM_PROBES} bestätigt):\n${PRODUCT_URL}\n\nSchnell sein!`);
    } else if(!available && wasAvailable){
      await tg(`🔴 Wieder ausverkauft.`);
    }
    wasAvailable = available;
  }
  return last;
}

// interner Timer (laeuft, solange der Dienst wach ist)
setInterval(()=>check().catch(e=>console.log('interval err',e.message)), INTERVAL_MIN*60*1000);
check().catch(e=>console.log('initial err',e.message));   // sofort beim Start

const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url, 'http://x');
  const json = (code,obj)=>{ res.writeHead(code,{'content-type':'application/json'}); res.end(JSON.stringify(obj,null,1)); };

  if(url.pathname === '/check'){
    return json(200, await check().catch(e=>({error:e.message})));
  }
  if(url.pathname === '/getchatid'){
    if(!BOT_TOKEN) return json(400,{error:'BOT_TOKEN fehlt'});
    try{
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
      const d = await r.json();
      const chats = (d.result||[]).map(u=>u.message?.chat).filter(Boolean)
        .map(c=>({id:c.id, name:c.first_name||c.title, type:c.type}));
      return json(200,{hint:'Schreibe dem Bot eine Nachricht, dann hier neu laden.', chats});
    }catch(e){ return json(500,{error:e.message}); }
  }
  // Health (kein Check) – fuer Browser-Besuche
  return json(200,{ ok:true, product:PRODUCT_URL, intervalMin:INTERVAL_MIN,
                    telegramConfigured: !!(BOT_TOKEN&&CHAT_ID), last });
});
server.listen(PORT, ()=>console.log('Notifier laeuft auf Port', PORT, '| Intervall', INTERVAL_MIN, 'min'));
