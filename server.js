// =====================================================================
//  MediaMarkt -> Telegram Verfuegbarkeits-Notifier  (Render Free)
// ---------------------------------------------------------------------
//  - 0 Dependencies (Node-Builtins: http + global fetch)
//  - SCHNELLER interner Poller (Sekunden) als Haupt-Treiber
//  - Self-Wakeup: pingt die eigene Render-URL, damit der Dienst nicht
//    einschlaeft (externer Cron nur noch optionales Sicherheitsnetz)
//  - MEHRERE Empfaenger; edge-getriggert pro User (kein Cooldown):
//      verfuegbar  -> alle, die es noch nicht haben, werden benachrichtigt
//      ausverkauft -> alle informiert + intern "re-armed"
//      wieder verfuegbar -> wieder alle
//  - dynamisches Abo: wer dem Bot schreibt, wird automatisch aufgenommen
//
//  Endpoints:  GET /  (Health/Keepalive) | GET /check | GET /getchatid
// =====================================================================
import http from 'node:http';

const env = process.env;
const PORT            = env.PORT || 10000;
const BOT_TOKEN       = env.BOT_TOKEN || '';
const CHAT_IDS        = (env.CHAT_IDS || env.CHAT_ID || '').split(',').map(s=>s.trim()).filter(Boolean);
const PRODUCT_URL     = env.PRODUCT_URL ||
  'https://www.mediamarkt.de/de/product/_ok-oac-7022-w-klimagerat-weiss-max-raumgrosse-67-m-2763143.html';
const SKU             = env.SKU || '2763143';
const SOLD_OUT_MARKER = env.SOLD_OUT_MARKER || 'mms-cofr-delivery_NOT_AVAILABLE';
const IN_STOCK_MARKER = env.IN_STOCK_MARKER || 'mms-cofr-delivery_AVAILABLE';
const A2C_MARKER      = env.A2C_MARKER      || 'cofr-add-to-basket-button';
const BLOCKED_MARKER  = env.BLOCKED_MARKER  || 'Reference&#32;ID';
const CHECK_INTERVAL_SEC = Math.max(2,  parseInt(env.CHECK_INTERVAL_SEC || '7', 10));   // Haupt-Poll-Takt
const CONFIRM_PROBES     = Math.max(1,  parseInt(env.CONFIRM_PROBES     || '3', 10));   // gegen CDN-Ausreisser
const CONFIRM_GAP_MS     = Math.max(300,parseInt(env.CONFIRM_GAP_MS     || '1200',10)); // Abstand der Bestaetigungen
const GONE_CONFIRM       = Math.max(1,  parseInt(env.GONE_CONFIRM       || '3', 10));   // so viele Checks "weg" in Folge -> erst dann re-armed (Anti-Flacker-Spam)
const KEEPALIVE_MIN      = Math.max(1,  parseInt(env.KEEPALIVE_MIN      || '10', 10));  // Self-Ping-Takt
const SELF_URL           = env.RENDER_EXTERNAL_URL || env.SELF_URL || '';               // Render setzt das automatisch
const UPDATES_SEC        = Math.max(5,  parseInt(env.UPDATES_SEC       || '20', 10));   // Abo-Erkennung

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r=>setTimeout(r,ms));

const subscribers = new Set(CHAT_IDS);   // Empfaenger (Env + dynamisch)
const notified    = new Set();           // wer im AKTUELLEN Fenster schon benachrichtigt wurde
let wasAvailable = false;
let goneStreak = 0;
let last = null, errStreak = 0, tgOffset = 0, checking = false;

// ---------- Telegram ----------
async function tgSend(chatId, text){
  if(!BOT_TOKEN){ console.log('[tg] (kein Token) ->', chatId, text.slice(0,40)); return; }
  try{
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview:false })
    });
    if(!r.ok) console.log('[tg] HTTP', r.status, await r.text());
  }catch(e){ console.log('[tg]', e.message); }
}
async function broadcastAvailable(){
  for(const id of subscribers){
    if(!notified.has(id)){
      await tgSend(id, `🟢 VERFÜGBAR! Jetzt kaufbar:\n${PRODUCT_URL}\n\n⚡ SCHNELL – ist meist in <1 Min weg!`);
      notified.add(id);
    }
  }
}
async function broadcastGone(){
  for(const id of subscribers) await tgSend(id, `🔴 Wieder ausverkauft. Du wirst beim nächsten Mal automatisch erneut benachrichtigt.`);
}

// ---------- EIN Abruf (KEIN Cache-Busting -> stabiler, korrekter Status) ----------
async function probe(){
  let status=0, html='';
  try{
    const r = await fetch(PRODUCT_URL,{ headers:{ 'user-agent':UA, 'accept-language':'de-DE,de;q=0.9' }});
    status = r.status; html = await r.text();
  }catch(e){ html=''; }
  const sane    = html.includes(SKU);
  const blocked = html.includes(BLOCKED_MARKER);
  const soldOut = html.includes(SOLD_OUT_MARKER);
  const inStock = html.includes(IN_STOCK_MARKER) && html.includes(A2C_MARKER);
  const pageOk  = status===200 && sane && !blocked;
  const available = pageOk && inStock && !soldOut;
  return { status, sane, blocked, soldOut, inStock, pageOk, available };
}

// ---------- Pruefung mit Schnell-Bestaetigung ----------
async function check(){
  if(checking) return last;        // keine Ueberlappung
  checking = true;
  try{
    let p = await probe();
    let confirms = p.available ? 1 : 0;
    if(p.available){
      for(let i=1;i<CONFIRM_PROBES;i++){
        await sleep(CONFIRM_GAP_MS);
        const q = await probe();
        if(q.available) confirms++; else { p = q; break; }
      }
    }
    const available = confirms >= CONFIRM_PROBES;
    last = { time:new Date().toISOString(), ...p, confirms, confirmNeeded:CONFIRM_PROBES,
             available, subs:subscribers.size, notified:notified.size };

    if(!p.pageOk){
      // transienter Fehler/Block -> Zustand NICHT aendern (kein Fehlalarm, kein Reset)
      errStreak++;
      if(errStreak===5) for(const id of subscribers)
        await tgSend(id, `⚠️ Notifier-Problem (HTTP ${p.status}, sane=${p.sane}, blocked=${p.blocked}). Evtl. IP geblockt → Intervall erhöhen.`);
    } else {
      errStreak = 0;
      if(available){
        wasAvailable = true; goneStreak = 0;
        await broadcastAvailable();        // alle noch nicht informierten User
      } else {
        // Hysterese: erst nach GONE_CONFIRM Checks "weg" in Folge re-armen
        goneStreak++;
        if(goneStreak >= GONE_CONFIRM){
          if(wasAvailable){ await broadcastGone(); }
          wasAvailable = false;
          notified.clear();                // re-arm: naechstes Mal wieder alle
        }
      }
    }
    return last;
  } finally { checking = false; }
}

// ---------- Abo-Erkennung: wer dem Bot schreibt, wird aufgenommen ----------
async function pollUpdates(){
  if(!BOT_TOKEN) return;
  try{
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=0&offset=${tgOffset}`);
    const d = await r.json();
    for(const u of d.result||[]){
      tgOffset = u.update_id + 1;
      const chat = u.message?.chat; if(!chat) continue;
      const id = String(chat.id);
      if(!subscribers.has(id)){
        subscribers.add(id);
        await tgSend(id, '✅ Abo aktiv! Du wirst benachrichtigt, sobald die Klimaanlage lieferbar ist.');
        if(wasAvailable && !notified.has(id)){ await tgSend(id, `🟢 Aktuell VERFÜGBAR:\n${PRODUCT_URL}`); notified.add(id); }
      }
    }
  }catch(e){ console.log('[updates]', e.message); }
}

// ---------- Timer ----------
setInterval(()=>check().catch(e=>console.log('check err',e.message)), CHECK_INTERVAL_SEC*1000);
setInterval(()=>pollUpdates().catch(()=>{}), UPDATES_SEC*1000);
if(SELF_URL) setInterval(()=>fetch(SELF_URL.replace(/\/$/,'')+'/').catch(()=>{}), KEEPALIVE_MIN*60*1000);
check().catch(()=>{}); pollUpdates().catch(()=>{});

// ---------- HTTP ----------
const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url, 'http://x');
  const json = (code,obj)=>{ res.writeHead(code,{'content-type':'application/json'}); res.end(JSON.stringify(obj,null,1)); };
  if(url.pathname === '/check')     return json(200, await check().catch(e=>({error:e.message})));
  if(url.pathname === '/getchatid'){
    if(!BOT_TOKEN) return json(400,{error:'BOT_TOKEN fehlt'});
    try{
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
      const d = await r.json();
      const chats = (d.result||[]).map(u=>u.message?.chat).filter(Boolean).map(c=>({id:c.id,name:c.first_name||c.title}));
      return json(200,{hint:'Schreibe dem Bot, dann neu laden.', chats});
    }catch(e){ return json(500,{error:e.message}); }
  }
  // Health / Keepalive-Ziel
  return json(200,{ ok:true, product:PRODUCT_URL, pollSec:CHECK_INTERVAL_SEC,
                    subscribers:subscribers.size, telegram:!!BOT_TOKEN, selfWakeup:!!SELF_URL, last });
});
server.listen(PORT, ()=>console.log(`Notifier auf :${PORT} | poll ${CHECK_INTERVAL_SEC}s | confirm ${CONFIRM_PROBES}x${CONFIRM_GAP_MS}ms | subs ${subscribers.size} | selfWakeup ${!!SELF_URL}`));
