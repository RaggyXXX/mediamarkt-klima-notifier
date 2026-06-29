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
//  Endpoints:  GET / | GET /walkietalkie | GET /check | GET /getchatid
//              POST /interactions  (Discord Slash-Commands)
// =====================================================================
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const env = process.env;
const PORT            = env.PORT || 10000;
const BOT_TOKEN       = env.BOT_TOKEN || '';
const CHAT_IDS        = (env.CHAT_IDS || env.CHAT_ID || '').split(',').map(s=>s.trim()).filter(Boolean);
const DISCORD_WEBHOOK = env.DISCORD_WEBHOOK_URL || '';            // Discord-Kanal-Webhook (Variante 1)
const DISCORD_BOT_TOKEN  = env.DISCORD_BOT_TOKEN || '';           // Bot-Token (Variante 2, REST)
const DISCORD_CHANNEL_ID = env.DISCORD_CHANNEL_ID || '';          // Ziel-Kanal-ID fuer Bot-Variante
const DISCORD_MENTION = (env.DISCORD_MENTION || '').trim();       // z.B. "everyone" oder "here" (optional Ping)
const DISCORD_PUBLIC_KEY = env.DISCORD_PUBLIC_KEY || '';          // fuer Slash-Command-Signaturpruefung
const DISCORD_ON = !!DISCORD_BOT_TOKEN;   // per-User-DMs via Bot

// 10 dumme, aber witzige Sprueche fuer die Verfuegbarkeits-Meldung
const FUNNY = [
  'Mein lieber Herrgesangsverein! Ich glaube, ein neues Erfrischungsgerät ist verfügbar. Howdy! 🤠',
  'Alaaarm! Die Wettermaschine ist gelandet. Schnapp sie dir, bevor\'s wieder schwül wird! 🥵',
  'Tatütata, die Klima-Feuerwehr! Das Gerät ist lieferbar — losdüsen! 🚒',
  'Heiliger Bimbam, kühle Brise im Anflug! Verfügbar. Zack zack, sonst weg! ❄️',
  'Achtung, der Eisbär ruft: Klimaanlage verfügbar — schlag zu, du Frostbeule! 🐻‍❄️',
  'Donnerwetter! Frische Luft auf Lager. Bestell jetzt, sonst schmilzt der Deal! 🫠',
  'Hört, hört! Die Pustemaschine steht im Laden. Husch husch zur Kasse! 💨',
  'Sapperlot, da isse! Dein persönlicher Sommer-Feind ist verfügbar. Angriff! ⚔️',
  'Yeehaw! Die Cool-Down-Kanone ist geladen und lieferbar. Nicht trödeln, Cowboy! 🤠',
  'Breaking News: Klimagerät gesichtet! Experten raten: sofort kaufen. 📰❄️',
];
const pickFunny = () => FUNNY[Math.floor(Math.random()*FUNNY.length)];
const PRODUCT_URL     = env.PRODUCT_URL ||
  'https://www.mediamarkt.de/de/product/_ok-oac-7022-w-klimagerat-weiss-max-raumgrosse-67-m-2763143.html';
const SKU             = env.SKU || '2763143';
const SOLD_OUT_MARKER = env.SOLD_OUT_MARKER || 'mms-cofr-delivery_NOT_AVAILABLE';
const IN_STOCK_MARKER = env.IN_STOCK_MARKER || 'mms-cofr-delivery_AVAILABLE';
const A2C_MARKER      = env.A2C_MARKER      || 'cofr-add-to-basket-button';
const BLOCKED_MARKER  = env.BLOCKED_MARKER  || 'Reference&#32;ID';
// Adaptives Polling: langsam wenn ausverkauft, schnell sobald "verfuegbar" gewittert wird.
const IDLE_SEC           = Math.max(2,  parseInt(env.IDLE_SEC || env.CHECK_INTERVAL_SEC || '4', 10)); // Takt wenn NICHT verfuegbar (~3-5s)
const ACTIVE_SEC         = Math.max(1,  parseInt(env.ACTIVE_SEC         || '2', 10));   // Takt SOLANGE verfuegbar (engmaschig)
const CONFIRM_PROBES     = Math.max(1,  parseInt(env.CONFIRM_PROBES     || '3', 10));   // Schnell-Verify gegen CDN-Ausreisser
const CONFIRM_GAP_MS     = Math.max(200,parseInt(env.CONFIRM_GAP_MS     || '600',10));  // kurzer Abstand im Verify-Modus
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
let availLine = '';          // gewaehlter Spruch fuers aktuelle Verfuegbarkeits-Fenster
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
function availText(){
  return `${availLine || pickFunny()}\n\n🟢 Jetzt kaufbar:\n${PRODUCT_URL}\n⚡ SCHNELL – ist meist in <1 Min weg!`;
}
async function broadcastAvailable(){
  for(const id of subscribers){
    if(!notified.has(id)){
      await tgSend(id, availText());
      notified.add(id);
    }
  }
}
async function broadcastGone(){
  for(const id of subscribers) await tgSend(id, `🔴 Wieder ausverkauft. Du wirst beim nächsten Mal automatisch erneut benachrichtigt.`);
}

// ---------- Discord: per-User-Abo (/notifyme) + DM bei Verfuegbarkeit ----------
const SUBS_FILE = './discord_subs.json';
const discordSubs = new Set(loadSubs());          // Discord-User-IDs
const notifiedDiscord = new Set();                // wer im aktuellen Fenster schon eine DM hat
function loadSubs(){ try{ return JSON.parse(fs.readFileSync(SUBS_FILE,'utf8')); }catch{ return []; } }
function saveSubs(){ try{ fs.writeFileSync(SUBS_FILE, JSON.stringify([...discordSubs])); }catch(e){ console.log('[subs] save', e.message); } }

const dHeaders = () => ({ authorization:`Bot ${DISCORD_BOT_TOKEN}`, 'content-type':'application/json' });
async function discordDM(userId, text){
  if(!DISCORD_BOT_TOKEN) return false;
  try{
    const chRes = await fetch('https://discord.com/api/v10/users/@me/channels',{ method:'POST', headers:dHeaders(), body:JSON.stringify({ recipient_id:userId }) });
    const ch = await chRes.json();
    if(!ch.id){ console.log('[dm] kein Kanal fuer', userId, JSON.stringify(ch).slice(0,120)); return false; }
    const r = await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`,{ method:'POST', headers:dHeaders(), body:JSON.stringify({ content:text }) });
    if(!r.ok){ console.log('[dm] HTTP', r.status, await r.text()); return false; }
    return true;
  }catch(e){ console.log('[dm]', e.message); return false; }
}
async function dmDiscordSubs(){
  for(const uid of discordSubs){
    if(!notifiedDiscord.has(uid)){
      const ok = await discordDM(uid, availText());
      if(ok) notifiedDiscord.add(uid);
    }
  }
}

// Discord-Interaktions-Signatur (Ed25519) pruefen
function verifyDiscordSig(sig, ts, rawBody){
  if(!DISCORD_PUBLIC_KEY || !sig || !ts) return false;
  try{
    const der = Buffer.concat([ Buffer.from('302a300506032b6570032100','hex'), Buffer.from(DISCORD_PUBLIC_KEY,'hex') ]);
    const key = crypto.createPublicKey({ key:der, format:'der', type:'spki' });
    return crypto.verify(null, Buffer.from(ts + rawBody), key, Buffer.from(sig,'hex'));
  }catch(e){ console.log('[verify]', e.message); return false; }
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
    console.log(`[${last.time.slice(11,19)}] avail=${available} (probe=${p.available} ${confirms}/${CONFIRM_PROBES}) soldOut=${p.soldOut} http=${p.status} -> mode=${available?'ACTIVE':'idle'}`);

    if(!p.pageOk){
      // transienter Fehler/Block -> Zustand NICHT aendern (kein Fehlalarm, kein Reset)
      errStreak++;
      if(errStreak===5) for(const id of subscribers)
        await tgSend(id, `⚠️ Notifier-Problem (HTTP ${p.status}, sane=${p.sane}, blocked=${p.blocked}). Evtl. IP geblockt → Intervall erhöhen.`);
    } else {
      errStreak = 0;
      if(available){
        const becameAvailable = !wasAvailable;     // echter Zustandswechsel?
        if(becameAvailable) availLine = pickFunny();  // pro Fenster EIN Spruch
        wasAvailable = true; goneStreak = 0;
        await broadcastAvailable();                 // Telegram: alle noch nicht informierten User
        await dmDiscordSubs();                      // Discord: alle Abonnenten (jeder 1x pro Fenster)
      } else {
        // Hysterese: erst nach GONE_CONFIRM Checks "weg" in Folge re-armen
        goneStreak++;
        if(goneStreak >= GONE_CONFIRM){
          if(wasAvailable){ await broadcastGone(); }
          wasAvailable = false;
          notified.clear(); notifiedDiscord.clear();   // re-arm: naechstes Mal wieder alle (Telegram + Discord)
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

// ---------- Adaptiver Poll-Loop ----------
// Naechster Takt haengt am Zustand: verfuegbar -> ACTIVE_SEC (engmaschig),
// sonst IDLE_SEC. Die Schnell-Verifikation passiert in check() selbst
// (CONFIRM_PROBES im CONFIRM_GAP_MS-Takt).
async function loop(){
  try{ await check(); }catch(e){ console.log('check err', e.message); }
  const next = (wasAvailable ? ACTIVE_SEC : IDLE_SEC) * 1000;
  setTimeout(loop, next);
}
loop();

setInterval(()=>pollUpdates().catch(()=>{}), UPDATES_SEC*1000);
if(SELF_URL) setInterval(()=>fetch(SELF_URL.replace(/\/$/,'')+'/walkietalkie').catch(()=>{}), KEEPALIVE_MIN*60*1000);
pollUpdates().catch(()=>{});

// ---------- HTTP ----------
const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url, 'http://x');
  const json = (code,obj)=>{ res.writeHead(code,{'content-type':'application/json'}); res.end(JSON.stringify(obj,null,1)); };
  // ---------- Discord Slash-Commands ----------
  if(url.pathname === '/interactions' && req.method === 'POST'){
    const sig = req.headers['x-signature-ed25519'];
    const ts  = req.headers['x-signature-timestamp'];
    let raw=''; for await (const chunk of req) raw += chunk;
    if(!verifyDiscordSig(sig, ts, raw)){ res.writeHead(401); return res.end('invalid request signature'); }
    let body={}; try{ body = JSON.parse(raw); }catch{}
    if(body.type === 1) return json(200, { type:1 });                 // PING -> PONG
    if(body.type === 2){                                              // Slash-Command
      const name = body.data && body.data.name;
      const userId = (body.member && body.member.user && body.member.user.id) || (body.user && body.user.id);
      let content;
      if(name === 'notifyme'){
        if(userId){ discordSubs.add(userId); saveSubs(); }
        content = '✅ Eingetragen! Sobald die Klimaanlage lieferbar ist, kriegst du von mir eine DM. 🌬️🤠';
      } else if(name === 'unnotifyme'){
        if(userId){ discordSubs.delete(userId); notifiedDiscord.delete(userId); saveSubs(); }
        content = '🔕 Abgemeldet. Keine Klima-Meldungen mehr für dich.';
      } else {
        content = 'Unbekannter Befehl.';
      }
      return json(200, { type:4, data:{ content, flags:64 } });        // ephemerale Antwort (nur fuer den User)
    }
    return json(200, { type:1 });
  }
  if(url.pathname === '/walkietalkie') return json(200, { awake:true, t:new Date().toISOString() }); // Stay-Awake-Ping (cron-job.org)
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
  return json(200,{ ok:true, product:PRODUCT_URL, idleSec:IDLE_SEC, activeSec:ACTIVE_SEC,
                    verify:`${CONFIRM_PROBES}x${CONFIRM_GAP_MS}ms`, currentlyAvailable:wasAvailable,
                    telegramSubs:subscribers.size, discordSubs:discordSubs.size,
                    telegram:!!BOT_TOKEN, discord:DISCORD_ON, slash:!!DISCORD_PUBLIC_KEY,
                    selfWakeup:!!SELF_URL, last });
});
server.listen(PORT, ()=>console.log(`Notifier auf :${PORT} | idle ${IDLE_SEC}s / active ${ACTIVE_SEC}s | verify ${CONFIRM_PROBES}x${CONFIRM_GAP_MS}ms | telegram ${!!BOT_TOKEN} | discord ${DISCORD_ON} | selfWakeup ${!!SELF_URL}`));
