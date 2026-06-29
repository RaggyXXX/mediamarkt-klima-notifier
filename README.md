# MediaMarkt → Telegram Verfügbarkeits-Notifier (Render Free)

Meldet dir per **Telegram**, sobald die Klimaanlage (OK OAC 7022 W, `2763143`) wieder **wirklich** lieferbar ist.
Dependency-frei (nur Node-Builtins), läuft auf **Render Free**.

## Wie die Verfügbarkeit erkannt wird (zuverlässig)
- Einfacher HTML-Abruf der Produktseite, **ohne** Cache-Busting → liefert den stabilen,
  korrekten Status (live getestet: 10/10 = identisch zu dem, was du im Browser siehst).
- **Positiver** Marker: lieferbar nur, wenn `mms-cofr-delivery_AVAILABLE` **und** der
  Warenkorb-Button `cofr-add-to-basket-button` da sind — und der Ausverkauft-Marker weg ist.
- **Bestätigung**: erst nach `CONFIRM_PROBES` Abrufen in Folge „verfügbar" wird gemeldet.
- **Cooldown**: max. eine „verfügbar"-Meldung pro `NOTIFY_COOLDOWN_MIN` (Anti-Spam bei Geflacker).
- **Sanity/Block-Schutz**: keine Meldung bei HTTP-Fehler/Akamai-Sperre/kaputter Seite.

> Hinweis: MediaMarkt liefert für diesen hochfrequenten Artikel gelegentlich abweichende
> Seiten-Varianten. Genau dagegen sind „positiver Marker + Bestätigung + Cooldown" gebaut.

## 1) Telegram-Bot anlegen
1. In Telegram **@BotFather** → `/newbot` → Name vergeben → du bekommst den **BOT_TOKEN**.
2. Deinem neuen Bot **eine Nachricht schreiben** (irgendwas, z. B. „hi").
3. **CHAT_ID** holen: entweder über **@userinfobot** (schreibt dir deine ID),
   oder nach dem Deploy `https://DEIN-SERVICE.onrender.com/getchatid` aufrufen.

## 2) Auf Render deployen
**Variante A – Blueprint (einfach):**
1. Code in ein **GitHub-Repo** pushen (siehe unten).
2. Render → **New + → Blueprint** → Repo auswählen → erkennt `render.yaml`.
3. Unter **Environment** eintragen: `BOT_TOKEN`, `CHAT_ID`. Deploy.

**Variante B – manuell:**
1. Render → **New + → Web Service** → Repo verbinden.
2. Runtime **Node**, Build `npm install`, Start `node server.js`, Plan **Free**.
3. Environment-Variablen setzen (siehe unten). Deploy.

### Environment-Variablen
| Variable | Wert |
|---|---|
| `BOT_TOKEN` | dein Telegram-Bot-Token |
| `CHAT_ID` | deine Telegram-Chat-ID |
| `PRODUCT_URL` | (vorbelegt: die Klimaanlage) |
| `SKU` | `2763143` |
| `CHECK_INTERVAL_MIN` | `10` (interner Timer, solange wach) |
| `CONFIRM_PROBES` | `3` |
| `NOTIFY_COOLDOWN_MIN` | `30` |

## 3) WICHTIG: Externer Cron gegen Render-Spindown
Render-Free-Dienste **schlafen nach 15 Min Inaktivität ein** → der interne Timer stoppt.
Lösung (kostenlos): bei **https://cron-job.org** einen Job anlegen, der alle paar Minuten
`https://DEIN-SERVICE.onrender.com/check` aufruft. Das **weckt** den Dienst **und** löst die Prüfung aus.
- Empfehlung: alle **2–3 Minuten** (cron-job.org erlaubt bis zu jede Minute).
- Bei hochfrequentem Artikel ruhig enger takten.

## Endpoints
- `GET /` – Status/Health (kein Check)
- `GET /check` – führt eine Prüfung aus (vom Cron aufrufen)
- `GET /getchatid` – zeigt Chat-IDs aus den letzten Bot-Nachrichten

## Lokal testen
```
BOT_TOKEN=... CHAT_ID=... node server.js
# dann http://localhost:10000/check aufrufen
```

## Grenzen (ehrlich)
- Render Free + externer Cron = Auflösung von ~1–3 Min. Ganz kurze Verfügbarkeits-Fenster
  eines hochfrequenten Artikels können dazwischenrutschen.
- Dieser Bot **benachrichtigt nur** — kaufen musst du selbst (schnell sein).
  Für vollautomatischen Kauf siehe das übergeordnete Projekt (`../README.md`).
