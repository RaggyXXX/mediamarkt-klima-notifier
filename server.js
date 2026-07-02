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
import { startPortaSplit, getPortaSnapshot } from './portasplit.mjs';   // PortaSplit-Watcher (gleicher Prozess)

const env = process.env;
const PORT            = env.PORT || 10000;
const BOT_TOKEN       = env.BOT_TOKEN || '';
const CHAT_IDS        = (env.CHAT_IDS || env.CHAT_ID || '').split(',').map(s=>s.trim()).filter(Boolean);
const DISCORD_WEBHOOK = env.DISCORD_WEBHOOK_URL || '';            // Discord-Kanal-Webhook (Variante 1)
const DISCORD_BOT_TOKEN  = env.DISCORD_BOT_TOKEN || '';           // Bot-Token (Variante 2, REST)
const DISCORD_CHANNEL_ID = env.DISCORD_CHANNEL_ID || '';          // Ziel-Kanal-ID fuer Bot-Variante
const DISCORD_MENTION = (env.DISCORD_MENTION || '').trim();       // z.B. "everyone" oder "here" (optional Ping)
const DISCORD_PUBLIC_KEY = env.DISCORD_PUBLIC_KEY || '';          // fuer Slash-Command-Signaturpruefung
const DISCORD_GUILD_ID  = env.DISCORD_GUILD_ID  || '';           // Server-ID (fuer Rollen)
const DISCORD_ROLE_ID   = env.DISCORD_ROLE_ID   || '';           // Rolle "Klima-Abo" -> /notify-me-here
const DISCORD_NOTIFY_CHANNEL_ID = env.DISCORD_NOTIFY_CHANNEL_ID || DISCORD_CHANNEL_ID; // wo @Rolle gepingt wird
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
const DELIVERY_WIDGET = env.DELIVERY_WIDGET || 'mms-cofr-delivery';   // Liefer-Widget-Anker (Sanity: muss server-seitig gerendert sein)
// Adaptives Polling: langsam wenn ausverkauft, schnell sobald "verfuegbar" gewittert wird.
const IDLE_SEC           = Math.max(2,  parseInt(env.IDLE_SEC || env.CHECK_INTERVAL_SEC || '4', 10)); // Takt wenn NICHT verfuegbar (~3-5s)
const ACTIVE_SEC         = Math.max(1,  parseInt(env.ACTIVE_SEC         || '2', 10));   // Takt SOLANGE verfuegbar (engmaschig)
const CONFIRM_PROBES     = Math.max(1,  parseInt(env.CONFIRM_PROBES     || '3', 10));   // Schnell-Verify gegen CDN-Ausreisser
const CONFIRM_GAP_MS     = Math.max(200,parseInt(env.CONFIRM_GAP_MS     || '600',10));  // kurzer Abstand im Verify-Modus
const GONE_CONFIRM       = Math.max(1,  parseInt(env.GONE_CONFIRM       || '3', 10));   // so viele Checks "weg" in Folge -> erst dann re-armed
const NOTIFY_COOLDOWN_MS = Math.max(0,  parseInt(env.NOTIFY_COOLDOWN_MIN || '15', 10))*60000; // min. Abstand zwischen 2 Meldungen (gegen Flacker-Spam)
const KEEPALIVE_MIN      = Math.max(1,  parseInt(env.KEEPALIVE_MIN      || '10', 10));  // Self-Ping-Takt
const SELF_URL           = env.RENDER_EXTERNAL_URL || env.SELF_URL || '';               // Render setzt das automatisch
const UPDATES_SEC        = Math.max(5,  parseInt(env.UPDATES_SEC       || '20', 10));   // Abo-Erkennung

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// ---------- fetch mit hartem Timeout ----------
// Ohne Timeout kann EIN haengender Request den ganzen Poll-Loop dauerhaft einfrieren
// (checking bleibt true). AbortController erzwingt ein Ende -> Loop laeuft immer weiter.
const FETCH_TIMEOUT_MS = Math.max(2000, parseInt(env.FETCH_TIMEOUT_MS || '12000', 10));
const PROBE_TIMEOUT_MS = Math.max(2000, parseInt(env.PROBE_TIMEOUT_MS || '10000', 10));
async function fetchT(url, opts={}, ms=FETCH_TIMEOUT_MS){
  const ac = new AbortController();
  const t = setTimeout(()=>ac.abort(new Error('timeout')), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

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

// ---------- Turso (cloud-SQLite, DAUERHAFT) — lokale SQLite ist nur Live-Cache ----------
// Beim Start aus Turso wiederherstellen; alle 2 Min + bei Events + bei SIGTERM flushen.
const TURSO_HTTP  = (env.TURSO_URL || '').replace(/^libsql:\/\//,'https://').replace(/\/$/,'');
const TURSO_TOKEN = env.TURSO_TOKEN || '';
const tursoOn = !!(TURSO_HTTP && TURSO_TOKEN);
const tArg  = v => (v===null||v===undefined) ? {type:'null'} : (typeof v==='number' ? (Number.isInteger(v)?{type:'integer',value:String(v)}:{type:'float',value:v}) : {type:'text',value:String(v)});
const tCell = c => (!c||c.type==='null') ? null : (c.type==='integer'?Number(c.value):c.value);
async function tPipeline(stmts){
  if(!tursoOn) return [];
  const body = { requests: [...stmts.map(s=>({type:'execute',stmt:{sql:s.sql,args:(s.args||[]).map(tArg)}})), {type:'close'}] };
  const r = await fetch(TURSO_HTTP+'/v2/pipeline',{ method:'POST', headers:{ authorization:'Bearer '+TURSO_TOKEN, 'content-type':'application/json' }, body:JSON.stringify(body) });
  if(!r.ok){ console.log('[turso]', r.status, (await r.text()).slice(0,150)); return []; }
  const d = await r.json();
  return (d.results||[]).map(res=>{
    if(res.type!=='ok' || !res.response || res.response.type!=='execute') return null;
    const R=res.response.result, cols=(R.cols||[]).map(c=>c.name);
    return (R.rows||[]).map(row=>Object.fromEntries(row.map((cell,i)=>[cols[i],tCell(cell)])));
  });
}
const tExec = async (sql,args) => (await tPipeline([{sql,args}]))[0] || [];

async function tursoInit(){
  if(!tursoOn){ console.log('[turso] aus (TURSO_URL/TURSO_TOKEN fehlt)'); return; }
  await tPipeline([
    {sql:'CREATE TABLE IF NOT EXISTS stats(key TEXT PRIMARY KEY, value TEXT)'},
    {sql:'CREATE TABLE IF NOT EXISTS availability_windows(id INTEGER PRIMARY KEY, available_at TEXT, available_local TEXT, weekday TEXT, hour INTEGER, gone_at TEXT, duration_sec INTEGER, checks_during INTEGER, dm_subs INTEGER, channel_subs INTEGER, tg_subs INTEGER)'},
    {sql:'CREATE TABLE IF NOT EXISTS daily(day TEXT PRIMARY KEY, windows INTEGER, checks INTEGER, errors INTEGER, avail_seconds INTEGER)'},
  ]);
  if(!db) return;
  try{
    for(const r of await tExec('SELECT key,value FROM stats')) dbSet(r.key, r.value);
    const wins = await tExec('SELECT * FROM availability_windows');
    for(const w of wins) db.prepare('INSERT OR REPLACE INTO availability_windows(id,available_at,available_local,weekday,hour,gone_at,duration_sec,checks_during,dm_subs,channel_subs,tg_subs) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(w.id,w.available_at,w.available_local,w.weekday,w.hour,w.gone_at,w.duration_sec,w.checks_during,w.dm_subs,w.channel_subs,w.tg_subs);
    for(const r of await tExec('SELECT * FROM daily')) db.prepare('INSERT OR REPLACE INTO daily(day,windows,checks,errors,avail_seconds) VALUES(?,?,?,?,?)').run(r.day,r.windows,r.checks,r.errors,r.avail_seconds);
    console.log(`[turso] wiederhergestellt: ${wins.length} Fenster`);
  }catch(e){ console.log('[turso] restore', e.message); }
}
let flushing=false;
async function flushToTurso(){
  if(!tursoOn || !db || flushing) return; flushing=true;
  try{
    const stmts=[];
    for(const r of dbAll('SELECT key,value FROM stats')) stmts.push({sql:'INSERT INTO stats(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',args:[r.key,r.value]});
    for(const w of dbAll('SELECT * FROM availability_windows')) stmts.push({sql:'INSERT OR REPLACE INTO availability_windows(id,available_at,available_local,weekday,hour,gone_at,duration_sec,checks_during,dm_subs,channel_subs,tg_subs) VALUES(?,?,?,?,?,?,?,?,?,?,?)',args:[w.id,w.available_at,w.available_local,w.weekday,w.hour,w.gone_at,w.duration_sec,w.checks_during,w.dm_subs,w.channel_subs,w.tg_subs]});
    for(const r of dbAll('SELECT * FROM daily')) stmts.push({sql:'INSERT OR REPLACE INTO daily(day,windows,checks,errors,avail_seconds) VALUES(?,?,?,?,?)',args:[r.day,r.windows,r.checks,r.errors,r.avail_seconds]});
    if(stmts.length) await tPipeline(stmts);
  }catch(e){ console.log('[turso] flush', e.message); }
  finally{ flushing=false; }
}

const subscribers = new Set(CHAT_IDS);   // Empfaenger (Env + dynamisch)
const notified    = new Set();           // wer im AKTUELLEN Fenster schon benachrichtigt wurde
let wasAvailable = false;
let goneStreak = 0;
let availLine = '';          // gewaehlter Spruch fuers aktuelle Verfuegbarkeits-Fenster
let last = null, errStreak = 0, tgOffset = 0, checking = false;
let driftAlerted = false, lastCheckAt = Date.now();   // Drift-Warnung (einmalig) + Watchdog-Heartbeat

// ---------- Telegram ----------
async function tgSend(chatId, text){
  if(!BOT_TOKEN){ console.log('[tg] (kein Token) ->', chatId, text.slice(0,40)); return; }
  try{
    const r = await fetchT(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview:false })
    }, 8000);
    if(!r.ok) console.log('[tg] HTTP', r.status, await r.text());
  }catch(e){ console.log('[tg]', e.message); }
}
function availText(){
  return `${availLine || pickFunny()}\n\n🟢 Jetzt kaufbar:\n${PRODUCT_URL}\n⚡ SCHNELL – ist meist in <1 Min weg!`;
}
async function broadcastAvailable(){
  await Promise.all([...subscribers].map(id => tgSend(id, availText())));   // parallel -> haelt den Loop kuerzer; Frequenz per Cooldown begrenzt
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
    const chRes = await fetchT('https://discord.com/api/v10/users/@me/channels',{ method:'POST', headers:dHeaders(), body:JSON.stringify({ recipient_id:userId }) }, 8000);
    const ch = await chRes.json();
    if(!ch.id){ console.log('[dm] kein Kanal fuer', userId, JSON.stringify(ch).slice(0,120)); return false; }
    const r = await fetchT(`https://discord.com/api/v10/channels/${ch.id}/messages`,{ method:'POST', headers:dHeaders(), body:JSON.stringify({ content:text }) }, 8000);
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
// ---------- Rolle "Klima-Abo" (sichtbares Abzeichen + @-Ping) ----------
async function assignRole(uid){
  if(!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID || !DISCORD_ROLE_ID) return false;
  try{ const r = await fetch(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${uid}/roles/${DISCORD_ROLE_ID}`,{ method:'PUT', headers:dHeaders() });
       if(!r.ok) console.log('[role+]', r.status, await r.text()); return r.ok; }catch(e){ console.log('[role+]', e.message); return false; }
}
async function removeRole(uid){
  if(!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID || !DISCORD_ROLE_ID) return false;
  try{ const r = await fetch(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${uid}/roles/${DISCORD_ROLE_ID}`,{ method:'DELETE', headers:dHeaders() }); return r.ok; }catch(e){ console.log('[role-]', e.message); return false; }
}
async function pingRole(){
  if(!DISCORD_BOT_TOKEN || !DISCORD_ROLE_ID || !DISCORD_NOTIFY_CHANNEL_ID) return false;
  const content = `<@&${DISCORD_ROLE_ID}>\n${availText()}`;
  try{ const r = await fetchT(`https://discord.com/api/v10/channels/${DISCORD_NOTIFY_CHANNEL_ID}/messages`,{ method:'POST', headers:dHeaders(),
        body:JSON.stringify({ content, allowed_mentions:{ roles:[DISCORD_ROLE_ID] } }) }, 8000);
       if(!r.ok) console.log('[rping]', r.status, await r.text()); return r.ok; }catch(e){ console.log('[rping]', e.message); return false; }
}

async function notifyDiscord(){
  await Promise.all([...dmSubs].map(uid => discordDM(uid, availText())));   // DM-Abonnenten parallel
  if(DISCORD_ROLE_ID) await pingRole();                          // EIN @Klima-Abo-Ping im Kanal
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
  const t0 = Date.now();
  let status=0, html='';
  for(let attempt=0; attempt<2; attempt++){
    try{
      const r = await fetchT(PRODUCT_URL,{ headers:{ 'user-agent':UA, 'accept-language':'de-DE,de;q=0.9' }}, PROBE_TIMEOUT_MS);
      status = r.status; html = await r.text();
      break;                                           // Antwort da -> kein Retry
    }catch(e){
      status=0; html='';
      if(attempt===0){ await sleep(400); continue; }   // ein schneller Retry bei Netz-/Timeout-Fehler
    }
  }
  const ms = Date.now()-t0;
  const blocked = html.includes(BLOCKED_MARKER);
  const widget  = html.includes(DELIVERY_WIDGET);            // Liefer-Widget ueberhaupt gerendert?
  const sane    = html.includes(SKU) && widget;             // Seite korrekt geladen UND Widget vorhanden
  const soldOut = html.includes(SOLD_OUT_MARKER);
  const inStock = html.includes(IN_STOCK_MARKER) && html.includes(A2C_MARKER);
  const pageOk  = status===200 && sane && !blocked;
  const available = pageOk && inStock && !soldOut;
  // Marker-Drift: HTTP 200, SKU da, nicht geblockt — aber das Liefer-Widget FEHLT.
  // => MediaMarkt hat vermutlich Layout/Marker geaendert; sonst wuerden wir jeden Restock STILL verpassen.
  const drift = status===200 && !blocked && html.includes(SKU) && !widget;
  return { status, sane, widget, blocked, soldOut, inStock, pageOk, available, drift, ms };
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
      // Marker-Drift: sofort + einmalig LAUT warnen — sonst verpassen wir jeden Restock still.
      if(p.drift && !driftAlerted){
        driftAlerted = true;
        dbEvent('drift', 'Liefer-Widget fehlt trotz HTTP 200 – Layout/Marker geaendert?');
        const warn = '⚠️ ACHTUNG: Seite lädt (HTTP 200), aber das Liefer-Widget fehlt. Vermutlich hat MediaMarkt Layout/Marker geändert — der Notifier erkennt Verfügbarkeit evtl. NICHT mehr! Bitte Marker prüfen.';
        for(const id of subscribers) await tgSend(id, warn);
        for(const uid of dmSubs)      await discordDM(uid, warn);
      }
      if(errStreak===5){ dbEvent('error', `HTTP ${p.status} sane=${p.sane} blocked=${p.blocked} drift=${p.drift}`);
        for(const id of subscribers)
          await tgSend(id, `⚠️ Notifier-Problem (HTTP ${p.status}, sane=${p.sane}, blocked=${p.blocked}). Evtl. IP geblockt → Intervall erhöhen.`); }
    } else {
      errStreak = 0; driftAlerted = false;
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
          flushToTurso().catch(()=>{});   // neues Fenster sofort sichern
        }
        windowChecks++;
        wasAvailable = true; goneStreak = 0;
        // COOLDOWN: max. 1 Meldung pro NOTIFY_COOLDOWN_MS -> kein Flacker-Spam
        const lastNotify = +(dbGet('last_notify_at')||0);
        if(Date.now() - lastNotify >= NOTIFY_COOLDOWN_MS){
          if(!availLine) availLine = pickFunny();
          await broadcastAvailable();   // Telegram
          await notifyDiscord();        // Discord: DM + EIN @Klima-Abo-Ping
          dbSet('last_notify_at', Date.now()); dbEvent('notify');
          console.log('[notify] Meldung raus');
        } else {
          console.log('[notify] unterdrueckt (Cooldown aktiv)');
        }
      } else {
        // Hysterese: erst nach GONE_CONFIRM Checks "weg" in Folge re-armen
        goneStreak++;
        if(goneStreak >= GONE_CONFIRM){
          if(wasAvailable){
            const dur = Math.round((Date.now()-availableSince)/1000);
            dbEvent('gone', `${dur}s verfuegbar`);
            if(db && currentWindowId){ try{ db.prepare('UPDATE availability_windows SET gone_at=?, duration_sec=?, checks_during=? WHERE id=?')
                                              .run(new Date().toISOString(), dur, windowChecks, currentWindowId); }catch{} dailyBump('avail_seconds', dur); }
            currentWindowId = null;
            flushToTurso().catch(()=>{});   // geschlossenes Fenster + Dauer sofort sichern
          }
          wasAvailable = false;
        }
      }
    }
    return last;
  } finally { checking = false; lastCheckAt = Date.now(); }   // Heartbeat fuer den Watchdog
}

// ---------- Abo-Erkennung: wer dem Bot schreibt, wird aufgenommen ----------
async function pollUpdates(){
  if(!BOT_TOKEN) return;
  try{
    const r = await fetchT(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=0&offset=${tgOffset}`, {}, 8000);
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

// ---------- Watchdog: erkennt einen haengenden Loop und wirft ihn neu an ----------
// Sicherheitsnetz fuer den Fall, dass check() trotz Timeouts je verklemmt (checking bleibt true).
setInterval(()=>{
  const ageMs = Date.now() - lastCheckAt;
  const maxMs = Math.max(60000, IDLE_SEC*1000*10);   // > 10 Zyklen ohne fertigen Check = verklemmt
  if(ageMs > maxMs){
    console.log(`[watchdog] kein Check seit ${Math.round(ageMs/1000)}s -> Reset & Loop-Neustart`);
    dbEvent('watchdog', `stall ${Math.round(ageMs/1000)}s`);
    checking = false;          // evtl. verklemmtes Flag loesen
    lastCheckAt = Date.now();  // Doppel-Reset vermeiden
    loop();                    // Loop neu anwerfen
  }
}, 30000);

setInterval(()=>pollUpdates().catch(()=>{}), UPDATES_SEC*1000);
if(SELF_URL) setInterval(()=>fetchT(SELF_URL.replace(/\/$/,'')+'/walkietalkie', {}, 8000).catch(()=>{}), KEEPALIVE_MIN*60*1000);
pollUpdates().catch(()=>{});
loadSubsRemote().catch(()=>{});   // persistente Abo-Liste aus Discord laden
tursoInit().catch(e=>console.log('[turso] init', e.message));   // dauerhafte Stats aus Turso wiederherstellen
setInterval(()=>flushToTurso().catch(()=>{}), 2*60*1000);       // alle 2 Min nach Turso sichern
for(const sig of ['SIGTERM','SIGINT']) process.on(sig, async()=>{ await flushToTurso().catch(()=>{}); process.exit(0); });  // beim Recycle sichern

// ---------- Absturz-Netze: lieber loggen & weiterlaufen als sterben ----------
process.on('unhandledRejection', e => console.log('[unhandledRejection]', (e && e.message) || e));
process.on('uncaughtException',  e => console.log('[uncaughtException]',  (e && e.message) || e));

// ---------- PortaSplit-Watcher: laeuft im selben Prozess, meldet ueber dieselben Kanaele ----------
async function portaAlert({ title, message, url }){
  const text = `${title}\n${message}${url ? '\n'+url : ''}`;
  await Promise.all([...subscribers].map(id => tgSend(id, text)));        // Telegram-Empfaenger
  await Promise.all([...dmSubs].map(uid => discordDM(uid, text)));        // Discord-DM-Abos
  if(DISCORD_BOT_TOKEN && DISCORD_ROLE_ID && DISCORD_NOTIFY_CHANNEL_ID){  // Discord Rollen-Ping (eigener Text)
    await fetchT(`https://discord.com/api/v10/channels/${DISCORD_NOTIFY_CHANNEL_ID}/messages`, { method:'POST', headers:dHeaders(),
      body: JSON.stringify({ content:`<@&${DISCORD_ROLE_ID}>\n${text}`, allowed_mentions:{ roles:[DISCORD_ROLE_ID] } }) }, 8000).catch(()=>{});
  }
}
startPortaSplit(portaAlert);

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
        if(DISCORD_ROLE_ID){                                   // Rollen-Modus
          const ok = userId ? await assignRole(userId) : false;
          content = ok
            ? '✅ Du hast die Rolle **🌬️ Klima-Abo**! Bei Verfügbarkeit wird die Rolle im Kanal gepingt. 📣🤠'
            : '⚠️ Konnte die Rolle nicht vergeben — Bot-Recht „Rollen verwalten" + Rollen-Hierarchie prüfen.';
        } else {                                               // Fallback: Kanal-Mention
          if(userId && channelId){
            if(!channelSubs.has(channelId)) channelSubs.set(channelId, new Set());
            channelSubs.get(channelId).add(userId); saveSubs();
          }
          content = '✅ Eingetragen! Bei Verfügbarkeit **pinge ich dich hier im Kanal**. 📣🤠';
        }
      } else if(name === 'unnotifyme'){
        if(userId){ unsubscribeEverywhere(userId); notifiedDiscord.delete(userId); saveSubs(); await removeRole(userId); }
        content = '🔕 Abgemeldet (DM, Kanal **und** Rolle entfernt). Keine Klima-Meldungen mehr für dich.';
      } else {
        content = 'Unbekannter Befehl.';
      }
      return json(200, { type:4, data:{ content, flags:64 } });        // ephemerale Antwort (nur fuer den User)
    }
    return json(200, { type:1 });
  }
  if(url.pathname === '/walkietalkie') return json(200, { awake:true, t:new Date().toISOString() }); // Stay-Awake-Ping (cron-job.org)
  if(url.pathname === '/portasplit') return json(200, { ts:new Date().toISOString(), sources:getPortaSnapshot() }); // PortaSplit-Status
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
                    selfWakeup:!!SELF_URL, turso:tursoOn, last });
});
server.listen(PORT, ()=>console.log(`Notifier auf :${PORT} | idle ${IDLE_SEC}s / active ${ACTIVE_SEC}s | verify ${CONFIRM_PROBES}x${CONFIRM_GAP_MS}ms | telegram ${!!BOT_TOKEN} | discord ${DISCORD_ON} | selfWakeup ${!!SELF_URL}`));
