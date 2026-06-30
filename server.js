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

// ---------- SQLite (Node-eingebaut, sammelt Statistik) ----------
// Hinweis: Render-Free-Disk ist ephemer -> Daten resetten bei Redeploy.
let db = null;
const dbSet = (k,v) => { if(db) try{ db.prepare('INSERT INTO stats(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(v)); }catch{} };
const dbGet = (k)   => { if(!db) return null; try{ const r=db.prepare('SELECT value FROM stats WHERE key=?').get(k); return r?r.value:null; }catch{ return null; } };
const dbInc = (k)   => { const v=(parseInt(dbGet(k)||'0',10)||0)+1; dbSet(k,v); return v; };
const dbAdd = (k,n) => { const v=(parseFloat(dbGet(k)||'0')||0)+(n||0); dbSet(k,v); return v; };
const dbEvent = (type,info='') => { if(db) try{ db.prepare('INSERT INTO events(ts,type,info) VALUES(?,?,?)').run(new Date().toISOString(),type,info); }catch{} };
const dbAll = (sql,...a) => { if(!db) return []; try{ return db.prepare(sql).all(...a); }catch{ return []; } };
const dbOne = (sql,...a) => { if(!db) return null; try{ return db.prepare(sql).get(...a); }catch{ return null; } };
// Berliner Zeit (was den User interessiert: "wie viel Uhr")
const berlinHour = (d) => +new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',hour12:false}).formatToParts(d).find(x=>x.type==='hour').value;
const berlinWeekday = (d) => new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',weekday:'short'}).format(d);
const berlinStr = (d) => new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',dateStyle:'medium',timeStyle:'short'}).format(d);
try{
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync('./data.db');
  db.exec(`
    CREATE TABLE IF NOT EXISTS stats(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, type TEXT, info TEXT);
    CREATE TABLE IF NOT EXISTS availability_windows(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      available_at TEXT,        -- ISO/UTC: wann verfuegbar geworden
      available_local TEXT,     -- Berlin lesbar
      weekday TEXT,             -- Berlin (Mo., Di., ...)
      hour INTEGER,             -- Berlin 0-23
      gone_at TEXT,             -- wann wieder weg
      duration_sec INTEGER,     -- wie lange verfuegbar = "wie schnell ausverkauft"
      checks_during INTEGER,    -- Checks waehrend des Fensters
      dm_subs INTEGER, channel_subs INTEGER, tg_subs INTEGER  -- Abo-Stand zum Zeitpunkt
    );
    CREATE TABLE IF NOT EXISTS daily(
      day TEXT PRIMARY KEY,     -- YYYY-MM-DD (Berlin)
      windows INTEGER DEFAULT 0,
      checks INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      avail_seconds INTEGER DEFAULT 0
    );
  `);
  if(!dbGet('started_at')) dbSet('started_at', new Date().toISOString());
  console.log('[db] SQLite aktiv (./data.db)');
}catch(e){ console.log('[db] SQLite nicht verfügbar:', e.message); }
const channelSubCount = () => [...channelSubs.values()].reduce((a,s)=>a+s.size,0);
const berlinDay = (d) => new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const dailyBump = (col, n=1) => { if(db) try{ db.prepare(`INSERT INTO daily(day,${col}) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET ${col}=${col}+excluded.${col}`).run(berlinDay(new Date()), n); }catch{} };
let currentWindowId = null, availableSince = 0, windowChecks = 0;

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

// ---------- Discord-Abos: /notify-me-dm (DM) + /notify-me-here (Kanal) ----------
// PERSISTENT: Abos werden in einer Discord-Nachricht gespeichert (ueberlebt
// Redeploy/Recycle, da nicht auf der ephemeren Render-Platte). Datei nur als
// lokaler Schnell-Cache.
const SUBS_FILE = './discord_subs.json';
const SUBS_MARKER = 'KLIMA_SUBS_V1';
const STORE_CHANNEL = env.DISCORD_STORE_CHANNEL_ID || DISCORD_CHANNEL_ID;   // wo die Abo-Liste liegt
let storeMsgId = null;
const dmSubs = new Set();                       // User-IDs (DM-Modus)
const channelSubs = new Map();                  // channelId -> Set(userId)  (Kanal-Modus)
const notifiedDiscord = new Set();              // userId, der im aktuellen Fenster schon Bescheid hat

const subsPayload = () => { const channels={}; for(const [ch,us] of channelSubs) channels[ch]=[...us]; return { dm:[...dmSubs], channels }; };
const applyPayload = (p) => {
  dmSubs.clear(); channelSubs.clear();
  (p.dm||[]).forEach(u=>dmSubs.add(u));
  for(const [ch,us] of Object.entries(p.channels||{})) channelSubs.set(ch, new Set(us));
};
function loadSubsFile(){ try{ applyPayload(JSON.parse(fs.readFileSync(SUBS_FILE,'utf8'))); }catch{} }
function saveSubsFile(){ try{ fs.writeFileSync(SUBS_FILE, JSON.stringify(subsPayload())); }catch{} }
function saveSubs(){ saveSubsFile(); saveSubsRemote().catch(e=>console.log('[subs] remote', e.message)); }  // beides
function unsubscribeEverywhere(uid){
  dmSubs.delete(uid);
  for(const [ch,us] of channelSubs){ us.delete(uid); if(!us.size) channelSubs.delete(ch); }
}
loadSubsFile();   // sofortiger lokaler Cache; Discord-Quelle ueberschreibt beim Start

const dHeaders = () => ({ authorization:`Bot ${DISCORD_BOT_TOKEN}`, 'content-type':'application/json' });

// Abo-Liste in Discord-Nachricht laden/speichern (persistent)
async function loadSubsRemote(){
  if(!DISCORD_BOT_TOKEN || !STORE_CHANNEL) return;
  try{
    const r = await fetch(`https://discord.com/api/v10/channels/${STORE_CHANNEL}/messages?limit=100`,{ headers:dHeaders() });
    const msgs = await r.json();
    if(!Array.isArray(msgs)) { console.log('[subs] load:', JSON.stringify(msgs).slice(0,120)); return; }
    const m = msgs.find(x=>x.content && x.content.startsWith(SUBS_MARKER));
    if(m){ storeMsgId = m.id; applyPayload(JSON.parse(m.content.slice(m.content.indexOf('{')))); saveSubsFile();
           console.log(`[subs] aus Discord geladen: DM ${dmSubs.size}, Kanal ${channelSubCount()}`); }
    else console.log('[subs] keine gespeicherte Liste gefunden (Start leer)');
  }catch(e){ console.log('[subs] load', e.message); }
}
async function saveSubsRemote(){
  if(!DISCORD_BOT_TOKEN || !STORE_CHANNEL) return;
  const content = `${SUBS_MARKER} ${JSON.stringify(subsPayload())}`;
  if(storeMsgId){
    const r = await fetch(`https://discord.com/api/v10/channels/${STORE_CHANNEL}/messages/${storeMsgId}`,{ method:'PATCH', headers:dHeaders(), body:JSON.stringify({ content }) });
    if(r.ok) return;
    if(r.status===404) storeMsgId=null; else { console.log('[subs] patch', r.status); return; }
  }
  const r = await fetch(`https://discord.com/api/v10/channels/${STORE_CHANNEL}/messages`,{ method:'POST', headers:dHeaders(), body:JSON.stringify({ content }) });
  if(r.ok){ const m=await r.json(); storeMsgId=m.id; } else console.log('[subs] post', r.status, await r.text());
}
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
async function channelPost(channelId, userIds, text){
  if(!DISCORD_BOT_TOKEN || !userIds.length) return false;
  const content = userIds.map(u=>`<@${u}>`).join(' ') + '\n' + text;
  try{
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`,{ method:'POST', headers:dHeaders(),
      body:JSON.stringify({ content, allowed_mentions:{ users:userIds } }) });
    if(!r.ok){ console.log('[chan] HTTP', r.status, await r.text()); return false; }
    return true;
  }catch(e){ console.log('[chan]', e.message); return false; }
}
async function notifyDiscord(){
  // DM-Abonnenten
  for(const uid of dmSubs){
    if(!notifiedDiscord.has(uid)){ if(await discordDM(uid, availText())) notifiedDiscord.add(uid); }
  }
  // Kanal-Abonnenten: pro Kanal eine Nachricht mit Mentions
  for(const [ch, us] of channelSubs){
    const fresh = [...us].filter(u=>!notifiedDiscord.has(u));
    if(fresh.length && await channelPost(ch, fresh, availText())) fresh.forEach(u=>notifiedDiscord.add(u));
  }
}

function fmtTime(iso){ return iso ? iso.slice(0,16).replace('T',' ')+' UTC' : '–'; }
const fmtDur = s => s==null?'–':(s>=60?`${Math.floor(s/60)}m ${s%60}s`:`${s}s`);
function statusText(){
  const cur = wasAvailable ? '🟢 **VERFÜGBAR**' : (last && last.pageOk ? '🔴 ausverkauft' : '⚠️ unklar');
  const dmN = dmSubs.size, chN = channelSubCount(), tgN = subscribers.size;
  const w = dbOne('SELECT COUNT(*) n, AVG(duration_sec) a, MIN(duration_sec) mn, MAX(duration_sec) mx FROM availability_windows WHERE duration_sec IS NOT NULL') || {};
  const topHour = dbOne('SELECT hour, COUNT(*) c FROM availability_windows GROUP BY hour ORDER BY c DESC LIMIT 1');
  const lastW = dbOne('SELECT available_local, duration_sec, gone_at FROM availability_windows ORDER BY id DESC LIMIT 1');
  const lines = [
    '🌡️ **Klima-Notifier — Status**',
    'Produkt: OK OAC 7022 W (2763143)',
    `Aktuell: ${cur}`,
    `Letzter Check: ${fmtTime(last && last.time)}`,
    `Checks gesamt: ${dbGet('total_checks')||0} (Fehler: ${dbGet('error_checks')||0})`,
    `Verfügbarkeits-Fenster bisher: ${w.n||0}`,
  ];
  if(w.n){
    lines.push(`⏱️ Verfügbar-Dauer: ø ${fmtDur(Math.round(w.a))} · kürzeste ${fmtDur(w.mn)} · längste ${fmtDur(w.mx)}`);
    if(topHour) lines.push(`🕐 Häufigste Uhrzeit: ${String(topHour.hour).padStart(2,'0')}:00 Uhr (${topHour.c}× · Berlin)`);
    if(lastW) lines.push(`📦 Letztes Fenster: ${lastW.available_local} · war ${fmtDur(lastW.duration_sec)} verfügbar`);
  }
  lines.push(
    `Abos: DM ${dmN} · Kanal ${chN} · Telegram ${tgN}`,
    `Läuft seit: ${fmtTime(dbGet('started_at'))} · Poll alle ${IDLE_SEC}s`,
    PRODUCT_URL,
  );
  return lines.join('\n');
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
  let status=0, html='', t0=Date.now();
  try{
    const r = await fetch(PRODUCT_URL,{ headers:{ 'user-agent':UA, 'accept-language':'de-DE,de;q=0.9' }});
    status = r.status; html = await r.text();
  }catch(e){ html=''; }
  const ms = Date.now()-t0;
  const sane    = html.includes(SKU);
  const blocked = html.includes(BLOCKED_MARKER);
  const soldOut = html.includes(SOLD_OUT_MARKER);
  const inStock = html.includes(IN_STOCK_MARKER) && html.includes(A2C_MARKER);
  const pageOk  = status===200 && sane && !blocked;
  const available = pageOk && inStock && !soldOut;
  return { status, sane, blocked, soldOut, inStock, pageOk, available, ms };
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

    dbInc('total_checks'); dbSet('last_check_at', last.time); dailyBump('checks');
    dbSet('last_status', !p.pageOk ? 'error' : (available ? 'available' : 'sold_out'));
    dbAdd('sum_latency_ms', p.ms||0); dbInc('latency_count');   // fuer Durchschnitts-Latenz
    if(p.pageOk){ if(available) dbInc('available_checks'); else dbInc('sold_out_checks'); }

    if(!p.pageOk){
      // transienter Fehler/Block -> Zustand NICHT aendern (kein Fehlalarm, kein Reset)
      errStreak++; dbInc('error_checks'); dailyBump('errors');
      if(errStreak===5){ dbEvent('error', `HTTP ${p.status} sane=${p.sane} blocked=${p.blocked}`);
        for(const id of subscribers)
          await tgSend(id, `⚠️ Notifier-Problem (HTTP ${p.status}, sane=${p.sane}, blocked=${p.blocked}). Evtl. IP geblockt → Intervall erhöhen.`); }
    } else {
      errStreak = 0;
      if(available){
        const becameAvailable = !wasAvailable;     // echter Zustandswechsel?
        if(becameAvailable){
          availLine = pickFunny();
          const now = new Date();
          availableSince = now.getTime(); windowChecks = 0;
          dbInc('available_events'); dbSet('last_available_at', last.time); dbEvent('available', `${berlinStr(now)}`); dailyBump('windows');
          if(db){ try{ const r = db.prepare('INSERT INTO availability_windows(available_at,available_local,weekday,hour,dm_subs,channel_subs,tg_subs,checks_during) VALUES(?,?,?,?,?,?,?,0)')
                          .run(now.toISOString(), berlinStr(now), berlinWeekday(now), berlinHour(now), dmSubs.size, channelSubCount(), subscribers.size);
                       currentWindowId = r.lastInsertRowid; }catch(e){ console.log('[win]', e.message); } }
        }
        windowChecks++;
        wasAvailable = true; goneStreak = 0;
        await broadcastAvailable();                 // Telegram: alle noch nicht informierten User
        await notifyDiscord();                      // Discord: DM- + Kanal-Abos (jeder 1x pro Fenster)
      } else {
        // Hysterese: erst nach GONE_CONFIRM Checks "weg" in Folge re-armen
        goneStreak++;
        if(goneStreak >= GONE_CONFIRM){
          if(wasAvailable){
            const dur = Math.round((Date.now()-availableSince)/1000);
            await broadcastGone(); dbEvent('gone', `${dur}s verfuegbar`);
            if(db && currentWindowId){ try{ db.prepare('UPDATE availability_windows SET gone_at=?, duration_sec=?, checks_during=? WHERE id=?')
                                              .run(new Date().toISOString(), dur, windowChecks, currentWindowId); }catch{} dailyBump('avail_seconds', dur); }
            currentWindowId = null;
          }
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
loadSubsRemote().catch(()=>{});   // persistente Abo-Liste aus Discord laden

// ---------- HTTP ----------
let DASHBOARD=''; try{ DASHBOARD = fs.readFileSync('./public/index.html','utf8'); }catch(e){ console.log('[ui] index.html fehlt:', e.message); }
const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url, 'http://x');
  const json = (code,obj)=>{ res.writeHead(code,{'content-type':'application/json'}); res.end(JSON.stringify(obj,null,1)); };
  if(url.pathname === '/' || url.pathname === '/dashboard'){
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return res.end(DASHBOARD || '<h1>Dashboard nicht geladen</h1>');
  }
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
      const channelId = body.channel_id || (body.channel && body.channel.id);
      if(name === 'status'){
        return json(200, { type:4, data:{ content: statusText() } });   // sichtbar fuer alle (kein flags:64)
      }
      let content;
      if(name === 'notify-me-dm'){
        if(userId){ dmSubs.add(userId); saveSubs(); }
        content = '✅ Eingetragen! Sobald die Klimaanlage lieferbar ist, kriegst du eine **DM**. 🌬️🤠';
      } else if(name === 'notify-me-here'){
        if(userId && channelId){
          if(!channelSubs.has(channelId)) channelSubs.set(channelId, new Set());
          channelSubs.get(channelId).add(userId); saveSubs();
        }
        content = '✅ Eingetragen! Bei Verfügbarkeit **pinge ich dich hier im Kanal**. 📣🤠';
      } else if(name === 'unnotifyme'){
        if(userId){ unsubscribeEverywhere(userId); notifiedDiscord.delete(userId); saveSubs(); }
        content = '🔕 Abgemeldet (DM **und** Kanal). Keine Klima-Meldungen mehr für dich.';
      } else {
        content = 'Unbekannter Befehl.';
      }
      return json(200, { type:4, data:{ content, flags:64 } });        // ephemerale Antwort (nur fuer den User)
    }
    return json(200, { type:1 });
  }
  if(url.pathname === '/walkietalkie') return json(200, { awake:true, t:new Date().toISOString() }); // Stay-Awake-Ping (cron-job.org)
  if(url.pathname === '/check')     return json(200, await check().catch(e=>({error:e.message})));
  if(url.pathname === '/stats'){
    const tc=+(dbGet('total_checks')||0), ac=+(dbGet('available_checks')||0);
    const lc=+(dbGet('latency_count')||0), ls=+(dbGet('sum_latency_ms')||0);
    return json(200, {
      counters: {
        total_checks: tc, available_checks: ac, sold_out_checks: +(dbGet('sold_out_checks')||0),
        error_checks: +(dbGet('error_checks')||0), available_events: +(dbGet('available_events')||0),
        availability_rate: tc ? +(100*ac/tc).toFixed(2) : 0,        // % der Checks "verfuegbar"
        avg_latency_ms: lc ? Math.round(ls/lc) : 0,
        last_available_at: dbGet('last_available_at'), last_check_at: dbGet('last_check_at'),
        last_status: dbGet('last_status'), started_at: dbGet('started_at'),
        currently_available: wasAvailable,
      },
      summary: dbOne('SELECT COUNT(*) windows, AVG(duration_sec) avg_sec, MIN(duration_sec) min_sec, MAX(duration_sec) max_sec, SUM(duration_sec) total_sec FROM availability_windows WHERE duration_sec IS NOT NULL'),
      byHour:    dbAll('SELECT hour, COUNT(*) windows, ROUND(AVG(duration_sec)) avg_sec FROM availability_windows GROUP BY hour ORDER BY hour'),
      byWeekday: dbAll('SELECT weekday, COUNT(*) windows, ROUND(AVG(duration_sec)) avg_sec FROM availability_windows GROUP BY weekday'),
      daily:     dbAll('SELECT * FROM daily ORDER BY day DESC LIMIT 30'),
      windows:   dbAll('SELECT * FROM availability_windows ORDER BY id DESC LIMIT 50'),
      recentEvents: dbAll('SELECT * FROM events ORDER BY id DESC LIMIT 40'),
    });
  }
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
                    telegramSubs:subscribers.size,
                    discordDmSubs:dmSubs.size, discordChannelSubs:[...channelSubs.values()].reduce((a,s)=>a+s.size,0),
                    telegram:!!BOT_TOKEN, discord:DISCORD_ON, slash:!!DISCORD_PUBLIC_KEY,
                    selfWakeup:!!SELF_URL, last });
});
server.listen(PORT, ()=>console.log(`Notifier auf :${PORT} | idle ${IDLE_SEC}s / active ${ACTIVE_SEC}s | verify ${CONFIRM_PROBES}x${CONFIRM_GAP_MS}ms | telegram ${!!BOT_TOKEN} | discord ${DISCORD_ON} | selfWakeup ${!!SELF_URL}`));
