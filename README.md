# MediaMarkt → Telegram Verfügbarkeits-Notifier (Render Free)

Meldet **mehreren** Empfängern per **Telegram**, sobald die Klimaanlage (OK OAC 7022 W, `2763143`)
wieder lieferbar ist. Dependency-frei (nur Node-Builtins), läuft auf **Render Free**.

## Architektur (schnell + selbstwachhaltend)
- **Schneller interner Poller** (`CHECK_INTERVAL_SEC`, Standard 7 s) – der eigentliche Treiber.
- **Self-Wakeup**: pingt alle `KEEPALIVE_MIN` die eigene Render-URL (`RENDER_EXTERNAL_URL`),
  damit der Free-Dienst nicht nach 15 Min einschläft. **Kein externer Cron nötig** (nur optional als Notnetz).
- **Erkennung ohne Cache-Busting** → stabiler, korrekter Status (live getestet = identisch zum Browser).
  Positiver Marker: `mms-cofr-delivery_AVAILABLE` **und** Warenkorb-Button `cofr-add-to-basket-button`.
- **Schnell-Bestätigung**: `CONFIRM_PROBES` Abrufe in Folge (je `CONFIRM_GAP_MS` Abstand) gegen CDN-Ausreißer.
- **Edge-getriggert pro User, kein Zeit-Cooldown**:
  - verfügbar → **alle** Empfänger, die es noch nicht haben, werden benachrichtigt (jeder 1× pro Fenster).
  - **Hysterese**: „wieder ausverkauft" zählt erst nach `GONE_CONFIRM` Checks in Folge → kein Spam bei Geflacker.
  - danach wieder verfügbar → wieder alle.
- **Dynamisches Abo**: Wer dem Bot schreibt, wird automatisch aufgenommen.

## 1) Telegram-Bot
1. `@BotFather` → `/newbot` → **BOT_TOKEN** notieren.
2. Dem Bot **„hi" schreiben** (sonst darf er dir nichts senden).
3. **Chat-ID**: via `@userinfobot` oder nach Deploy `…/getchatid`.
   Mehrere Empfänger: alle schreiben dem Bot (Auto-Abo) **oder** IDs kommagetrennt in `CHAT_IDS`.

## 2) Auf GitHub pushen
```bash
cd render-notifier
git remote add origin https://github.com/DEINNAME/klima-notifier.git
git push -u origin master
```

## 3) Render deployen
**New + → Blueprint** → Repo wählen (erkennt `render.yaml`) → unter **Environment**
`BOT_TOKEN` + `CHAT_IDS` eintragen → Deploy. Fertig – `RENDER_EXTERNAL_URL` setzt Render selbst,
damit funktioniert der Self-Wakeup automatisch.

### Wichtige Env-Variablen
| Variable | Standard | Bedeutung |
|---|---|---|
| `BOT_TOKEN` | – | Telegram-Bot-Token |
| `CHAT_IDS` | – | Empfänger, kommagetrennt (optional, da Auto-Abo) |
| `CHECK_INTERVAL_SEC` | `7` | Poll-Takt. Für hochfrequent ggf. `5` |
| `CONFIRM_PROBES` | `3` | Bestätigungen gegen Fehlalarm |
| `CONFIRM_GAP_MS` | `1200` | Abstand der Bestätigungen |
| `GONE_CONFIRM` | `3` | „weg"-Checks in Folge bis Re-Trigger (Anti-Flacker) |
| `KEEPALIVE_MIN` | `10` | Self-Wakeup-Takt |

## 4) (Optional) Externer Cron als Notnetz
Self-Wakeup reicht normalerweise. Falls der Dienst doch mal komplett einschläft
(z. B. nach Deploy/Crash) und sich nicht selbst wecken kann, leg bei **cron-job.org**
einen Ping auf `…/` alle ~12 Min an. Reiner Sicherheitsgurt.

## Endpoints
`GET /` Health/Keepalive · `GET /check` manuelle Prüfung · `GET /getchatid` Chat-IDs anzeigen

## Ehrliche Grenzen
- Der Artikel **flackert real** (mal lieferbar, mal nicht, im Sekundentakt). Der Bot meldet bei einem
  bestätigten Fenster – kaufen musst du dann **sofort selbst** (geht oft in <1 Min wieder weg).
- Aggressives Polling (z. B. 5 s) erhöht das Risiko einer IP-Sperre durch MediaMarkt/Akamai.
  Der Block-Schutz verhindert Fehlalarme und warnt dich; dann Intervall erhöhen.
- Für echten Auto-Kauf siehe übergeordnetes Projekt (`../README.md`).
