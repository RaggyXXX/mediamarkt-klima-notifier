# Notifier-Ausbau — Stats + Telegram-Buttons + Health

**Datum:** 2026-07-07 · **Scope:** nur `render-notifier` (MediaMarkt-Klima + PortaSplit), Broadcast an alle Abonnenten (keine Pro-Nutzer-Prefs). Kein neuer Service. Extras (Such-Fallback, externer Cron) bewusst NICHT enthalten.

## Ziel
Sauberes Telegram-Menü mit In-Chat-Buttons, ein Health/Status-Befehl, und saubere Statistiken über alle Quellen — persistiert in der bestehenden Turso-DB.

## Teil 1 — Telegram: Menü + Inline-Buttons
- `/menu` (+ `/start`) sendet ein Inline-Keyboard: **🟢 Status · 📊 Statistik · 🔔 Abo an · 🔕 Abo aus · ℹ️ Hilfe**.
- `pollUpdates` verarbeitet zusätzlich `callback_query`: `answerCallbackQuery` (stoppt Spinner) + Antwort (Nachricht editieren wo sinnvoll).
- setMyCommands: `/menu /status /stats /abo /stop`.
- Alert-Nachrichten erhalten Buttons: „🛒 Zum Angebot" (URL) + „🔕 Abmelden".
- callback_data-Werte: `status`, `stats`, `sub`, `unsub`, `help`, `menu`.

## Teil 2 — Health/Status (`/status` + 🟢-Button)
Ausgabe: „läuft seit <Uptime>" (Prozessstart), letzter Check (MediaMarkt + PortaSplit-Quellen), MediaMarkt-Zustand (verfügbar/ausverkauft/blockiert), Quellen-Gesundheit (letzter HTTP-Status + avail je Quelle), Abonnentenzahl.

## Teil 3 — Statistiken + Turso
Zwei neue Turso-Tabellen (aggregiert, kein Zeilen-Spam):
- `restocks(id INTEGER PK AUTOINCREMENT, ts, service, retailer, product, price, gone_at, duration_sec)` — jedes Verfügbarkeits-Fenster beider Watcher.
- `source_stats(source_id PK, retailer, product, checks, errors, restocks, last_status, last_avail, last_price, last_check, updated_at)` — pro Quelle Zähler + letzter Zustand (upsert).
- Bestehende `stats/daily/availability_windows/subscribers` bleiben. MediaMarkt schreibt Fenster künftig auch in `restocks`.
- `/stats` (+ 📊-Button): Restocks gesamt & je Händler, letzte 5 Fenster, Quellen-Fehlerquote, Meldungen gesamt.

## Teil 4 — Web-Dashboard
Bestehendes Dashboard `/` erhält Quellen-Gesundheitstabelle + Restock-Historie (gleiche Daten wie `/stats`).

## Datenerfassung (Verdrahtung)
- Jeder PortaSplit-Probe + MediaMarkt-Check aktualisiert `source_stats` (checks++, ggf. errors++, last_status/avail/price/check).
- Öffnet/schließt sich ein Verfügbarkeits-Fenster → Zeile in `restocks`.
- Prozessstart-Zeit in `stats` (bzw. Modulkonstante) für Uptime.

## Verifikation
- Bot-Menü: `/menu` zeigt Buttons; Klick auf jeden Button liefert korrekte Antwort (lokal gegen echte Bot-API mit Test-Chat).
- `/status` zeigt plausible Uptime + letzten Check.
- `source_stats`/`restocks` füllen sich (lokaler Probe-Lauf); `/stats` liest sie korrekt.
- Turso-Schema legt neue Tabellen an, Restore beim Boot ok.
