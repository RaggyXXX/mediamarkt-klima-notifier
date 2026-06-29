# MediaMarkt → Telegram Verfügbarkeits-Notifier (Render Free)

Meldet **mehreren** Empfängern per **Telegram**, sobald die Klimaanlage (OK OAC 7022 W, `2763143`)
wieder lieferbar ist. Dependency-frei (nur Node-Builtins), läuft auf **Render Free**.

## Architektur (adaptiv + selbstwachhaltend)
- **Adaptiver Poller**: im Leerlauf alle `IDLE_SEC` (≈4 s); sobald ein Abruf „verfügbar" wittert,
  sofort **Schnell-Verify** (`CONFIRM_PROBES`×`CONFIRM_GAP_MS`) und danach engmaschig alle `ACTIVE_SEC`.
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

## Kanäle: Telegram und/oder Discord
Beide laufen parallel — du kannst nur einen oder beide aktivieren.
- **Telegram**: per User (edge-getriggert, Auto-Abo). Siehe Schritt 1.
- **Discord**: per **Webhook** in einen Kanal (jeder im Kanal sieht's). Eine Nachricht pro Zustandswechsel.

### Discord-Webhook einrichten
1. In Discord: **Servereinstellungen → Integrationen → Webhooks → Neuer Webhook** → Kanal wählen → **Webhook-URL kopieren**.
2. Als Env-Variable `DISCORD_WEBHOOK_URL` eintragen.
3. Optional `DISCORD_MENTION=everyone` (oder `here`) für einen Ping.

(Hinweis: Das ist ein Webhook, kein Gateway-Bot mit Slash-Commands — für reine Benachrichtigungen ideal und Render-Free-tauglich.)

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
| `BOT_TOKEN` | – | Telegram-Bot-Token (optional, wenn nur Discord) |
| `CHAT_IDS` | – | Telegram-Empfänger, kommagetrennt (optional, da Auto-Abo) |
| `DISCORD_WEBHOOK_URL` | – | Discord-Kanal-Webhook (optional) |
| `DISCORD_MENTION` | – | leer / `everyone` / `here` (optionaler Ping) |
| `IDLE_SEC` | `4` | Poll-Takt wenn **nicht** verfügbar (~3–5 s) |
| `ACTIVE_SEC` | `2` | Poll-Takt **solange** verfügbar (engmaschig) |
| `CONFIRM_PROBES` | `3` | Schnell-Verify-Abrufe gegen Fehlalarm |
| `CONFIRM_GAP_MS` | `600` | Abstand im Verify-Modus |
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
