# Torn Attack Intelligence — Technical Blueprint v1.0

Status: **Implementierungs-Spezifikation**, kein fertig getestetes TornPDA-Script. Stand: 29. Oktober 2026.

## Ziel

Separates, mobiloptimiertes TornPDA-Userscript zum Auswerten der **eingehenden** Angriffe gegen den eigenen Account. Fokus: Angriffe pro Tag/Woche/Monat, gestohlenes Geld (anonym/bekannt), Wiederholungstäter, Torn City vs. Ausland, schnelles Bazaar-Blacklisting, Heatmap und Angriffe je 24 Stunden Aufenthalt.

**Bewusste Nicht-Ziele:** Keine automatische Spieler-Blockierung, kein Enttarnen anonymer Gegner, kein Angriffsauslösen, keine automatische Torn-Aktion, keine Buy-Mugging-Vermutung.

## Architektur

```text
TornPDA Userscript (Dashboard + Einstellungen)
  ├── ApiClient
  │    ├── GET /v2/user/basic                     → eigene Player-ID
  │    ├── GET /v2/user/attacks?filters=incoming   → Angriffe und Täter-IDs
  │    ├── GET /v2/user/log                      → Geld- und Reiseereignisse
  │    ├── GET /v2/torn/logtypes & logcategories  → gültige Logtypen/Kategorien
  │    └── GET /v2/user/list                     → vorhandene Enemy-Einträge (optional)
  ├── SyncEngine
  │    ├── Paginierung (_metadata.links.next)
  │    ├── Deduplikation (attack.id / log.id)
  │    └── inkrementelle Synchronisation mit Überlappung
  ├── Normalizer
  │    ├── IncomingAttack
  │    ├── MuggingLoss (verifizierter Datenfeldwert)
  │    └── LocationInterval (Torn / Ausland / Flug / unbekannt)
  ├── AnalyticsEngine
  │    ├── Zeitreihen
  │    ├── Täter-Ranking
  │    ├── Verluste
  │    ├── Heatmap (TCT = UTC)
  │    └── Exposition / 24h
  ├── PDA_storage (persistente per-script Daten)
  └── UI (Floating-Button, Fullscreen-Dashboard, sichere Profil-Links)
```

## Datenquellen (offizieller Stand)

| Endpoint | Schlüsselrecht | Inhalt | Einschränkung |
|---|---|---|---|
| `/v2/user/basic` | Minimal | Eigene Player-ID | Nur zur Abgrenzung eingehender Angriffe |
| `/v2/user/attacks` | Limited | `id`, `started`, `ended`, `attacker`, `defender`, `result`, Flags | `attacker` kann `null` sein; kein garantierter Mugging-Betrag |
| `/v2/user/log` | Full | `id`, `timestamp`, `details`, dynamische `data` und `params` | Logfelder je Typ verschieden; Money-Parser erst mit echten Beispieldaten verifizieren |
| `/v2/torn/logtypes`, `/v2/torn/logcategories` | Public | Logtypen- und Kategorie-IDs | Nicht nach vermuteten festen IDs filtern |
| `/v2/user/list` | Limited | Bestehende Enemy List | Keine schreibende Blacklist-API |
| `/v2/user/travel` | Limited | Aktuelle Reisesituation | Keine vollständige historische Standortquelle; für Historie Reise-Logs nötig |

API-Authentifizierung: über in TornPDA vorhandenen API-Key und `PDA_httpGet()` mit `Authorization: ApiKey …`; keine manuelle Übermittlung oder Speicherung des Schlüssels. Für vollständige Verlust- und Reisefunktionen ist ein passend eingeschränkter Custom-Key mit `/user/log` erforderlich. Fehlende Rechte werden im Dashboard pro Modul angezeigt.

## Persistentes Datenmodell

### Attack (Map `attacksById`, Primärschlüssel = `attack.id`)

```json
{
  "id": 123456,
  "startedAt": 1793260000,
  "endedAt": 1793260012,
  "attackerId": null,
  "attackerName": null,
  "attackerFactionId": null,
  "attackerFactionName": null,
  "isAnonymous": true,
  "result": "Mugged",
  "isRankedWar": false,
  "isRaid": false,
  "isTerritoryWar": false,
  "lossAmount": null,
  "lossMatchStatus": "not_found",
  "location": "unknown",
  "locationConfidence": "unknown"
}
```

- `lossAmount = null` heißt **unbekannt**; `lossAmount = 0` nur, wenn $0 tatsächlich bestätigt wurde.
- `attackerId = null` bleibt immer anonym; mehrere anonyme Angriffe **niemals** zu einer einzelnen Person zusammenfassen.
- Name ist nur ein Anzeigeattribut; Ranking wird stets nach `attackerId` gruppiert.

### LogEntry (`logsById`, Primärschlüssel = `log.id`)

```json
{
  "id": "unique-log-id",
  "timestamp": 1793260012,
  "logTypeId": 0,
  "title": "…",
  "category": "Attacking",
  "data": {},
  "params": {}
}
```

Beim Speichern nur relevante Angriffs-, Mugging- und Reiselogs übernehmen. Dynamische Felder bleiben bis zur Verifikation im Roharchiv; Schlüssel nicht unnötig duplizieren.

### LocationInterval

```json
{
  "start": 1793200000,
  "end": 1793210000,
  "type": "abroad",
  "country": "Japan",
  "source": "travel-log",
  "confidence": "confirmed"
}
```

`type`: `torn`, `abroad`, `flight`, `unknown`; alle Intervalle halboffen `[start,end)` und ohne Überlappung. Fehlen Ankunfts-/Abflugereignisse, den fraglichen Zeitraum als `unknown` markieren.

### Settings / SyncStatus

`schemaVersion`, `period`, `timezoneMode`, `lastSyncAttacks`, `lastSyncLogs`, `historyCoverageStart`, `logParserVersion`, `lastError`, `syncWarnings`, `lastExportAt`.

## Synchronisation

1. Script lädt lokal gespeicherte Datensätze, zeigt sofort das Dashboard an.
2. Nach manuellem »Sync« oder beim Öffnen (mit Cooldown) `/user/basic` und `/user/attacks?filters=incoming&limit=100&sort=DESC` abrufen.
3. Paginierung durch `_metadata.links.next`; begrenzt, mit sichtbarer Fortschrittsanzeige. Bereits vorhandene Attack-IDs upserten, keine Doppelzählung.
4. Beim erneuten Sync mit **2 Stunden Überlappung** ab zuletzt erfolgreich verarbeitetem Zeitstempel suchen; bei lückenhafter Historie gezielten Backfill erlauben.
5. Für Mugging-Verluste Logtyp-IDs anhand `/torn/logtypes` ermitteln und `/user/log` mit `log=<IDs>` abrufen. Reiserelevante Logs getrennt importieren. Wegen Logs in derselben Sekunde die API-Paginierung inkl. `nanostamp` / `_metadata.links.next` befolgen.
6. Aus den Travel-Logs zunächst Timeline der Abflüge/Ankünfte bilden; offene Intervalle nicht raten.
7. Log-Beträge **nur** aus verifiziertem Feld mit defensiver Plausibilitätsprüfung übernehmen. Matching über expliziten Attack-Verweis bevorzugen, sonst eindeutiges Zeitfenster + Mugged-Resultat; bei mehreren Kandidaten `ambiguous` und unverknüpft lassen.
8. Roh- und normalisierte Daten versioniert in `PDA_storage` speichern. Dann Analytics neu rechnen.
9. Fehler 429/API-Limits, ungültigen Key, fehlende Berechtigung und Storage-Limit sichtbar behandeln. Keine Endlosschleifen oder automatischen massenhaften Requests.

**Sync-Modus:** nur bei geöffneter TornPDA-Sitzung, standardmäßig beim Dashboard-Öffnen plus manueller Aktualisierung; keine implizite Hintergrundsynchronisation.

## Dashboard-Ansichten & Formeln

### 1. Überblick

KPI-Karten für alle eingehenden Angriffe, davon Mugging, bekannten und anonymen Anteil, **bestätigte** Geldverluste und Anzahl bekannter Angreifer mit mindestens zwei Attacken. Zeitraum: 24h / 7d / 30d / Gesamt.

### 2. Tages-/Wochen-/Monats-Trend

Angriffe nach **End-Zeitpunkt** gruppieren. Tage in TCT/UTC; Wochen ISO (Montag 00:00 UTC); Monate UTC. Leere Tage mit 0 anzeigen, jedoch nicht vor belegtem Historienbeginn. Kombiniertes Diagramm: Balken Angriffe, getrennte (optionale) Kurve bestätigte Mugging-Verluste. Filter Mugging vs. andere Angriffsergebnisse.

### 3. Geldverlust

- `confirmedTotal = Σ lossAmount` über alle **bestätigten** Werte;
- `knownLoss = Σ lossAmount` bei `attackerId != null`;
- `anonymousLoss = Σ lossAmount` bei `attackerId == null`;
- `unknownLossCount = count(lossAmount == null AND result == Mugged)`;
- Summen deutlich als **bestätigt / mindestens** kennzeichnen, sofern Unknowns verbleiben.

### 4. Wiederholungstäter

Sortierung: `count(attackerId)` absteigend, sekundär `confirmedLoss`, danach letzter Angriff. Spalten: Spieler, Hits, Muggings, bestätigter Schaden, letzter Angriff, »Profil« und »Blacklist«. **Anonym** wird als gesonderte Sammelzeile ohne Täter-ID angezeigt, nicht als Wiederholungstäter.

### 5. Torn City vs. Abroad

Jeden Angriff anhand `endedAt` gegen bekannte LocationIntervals joinen. Anzeigen: Torn City, Abroad, Flug (falls je Angriffe vorkommen), Unknown. Ausland optional nach Land. Standort unklar => `unknown` – keinerlei Heuristik aus bloßem Attack-Modifikator als Tatsachenbehauptung.

### 6. Heatmap

7 Zeilen (Mo–So) × 24 Spalten (0–23 Uhr TCT/UTC) mit Angriffsanzahl und Tooltip zu Anzahl, Mugging-Häufigkeit und bestätigten Verlusten. Filter nach Standort. Heatmap der Rohzahl; optional spätere Normalisierung für ungleiche Zeitfenster.

### 7. Angriffe je 24h Aufenthalt

Für jedes Gebiet `X`:

```text
exposureHours(X) = Σ Dauer(Schnittmenge(Auswertungsfenster, bestätigtes Standortintervall X)) / 3600
attacksPer24h(X) = attacksLocatedIn(X) * 24 / exposureHours(X)
```

Bedingung: Auswertungsfenster und Aufenthaltsintervalle ausreichend vollständig; unbekannte Zeit **nicht** Torn City zuschlagen. Bei `exposureHours = 0` oder unvollständiger Basis `—` / »nicht berechenbar« ausgeben. Flüge getrennt ausschließen; bei Ausland nur Zeiten *am Zielort* berücksichtigen.

## Blacklist-Workflow

Im Ranking:

- »Profil« öffnet `https://www.torn.com/profiles.php?XID=<PLAYER_ID>`.
- »Blacklist« öffnet ebenfalls die Torn-Oberfläche zur **manuellen** Aufnahme in die Enemies List; das Script klickt keine spielverändernden Aktionen selbst.
- Der Torn-Schalter **»Disallow Exchanges«** muss für die Enemies List eingeschaltet sein: Das ist eine **globale** Regel für die aufgelisteten Spieler, keine getrennte Einstellung pro einzelner Person. Die Liste blockiert dann auch Bazaar-Käufe.
- Keine Aktion bei `attackerId = null`.
- Der UI-Status »auf Enemies List« darf nur nach bestätigtem Abgleich mit `/user/list` angezeigt werden; andernfalls »nicht geprüft«.

## TornPDA-Integration

- Ein eigenständiges Userscript mit `@match *://*.torn.com/*` und eindeutiger `@namespace`.
- Kleiner, fixierter Floating-Button »🛡« mit öffnender Fullscreen-Oberfläche; keine Änderung am bestehenden Travel-Script.
- API-Key über TornPDAs Platzhalter `###PDA-APIKEY###`, HTTP über `PDA_httpGet`.
- Lokale Daten über `PDA_storage`; standardmäßig 10 MB, gegebenenfalls von Nutzer erhöhbar.
- Mobiles Design: große Touch-Ziele, Dark Mode, keine Tabellen, die horizontal den Viewport sprengen.
- Export: JSON für verlustfreie Sicherung / späteren Import, CSV für Auswertungen. Key niemals exportieren.

## Datenqualitäts- und Testfälle

1. Ein Angriff, der zweimal geladen wird, zählt genau einmal.
2. Ein unbekannter Täter erscheint in der Anonym-Summe, **nicht** im Wiederholungstäter-Ranking.
3. Der Mugging-Betrag ist `null`, wenn aus Logs nicht sicher extrahierbar; nie ersatzweise 0.
4. Zwei Mugging-Logs zur selben Zeit werden nicht irrtümlich demselben Angriff zugeordnet.
5. Ein 24h-Zeitraum mit 2 Angriffen und 6h **bestätigter** Aufenthalt ergibt 8/24h, andernfalls fehlende Basis markieren.
6. Angriffe außerhalb aller Reiseintervalle zählen als `unknown`.
7. 30-Tage-Zeitraum umfasst tatsächlich exakt gewählten UTC-Grenzbereich.
8. Enemies-Listen-Status nicht allein aus Klick auf »Blacklist« als erfolgreich markieren.
9. Fehler bei fehlendem Full-Log-Zugriff sperrt nicht die grundsätzlich nutzbare Angriffsübersicht.
10. Daten bleiben nach Cache-Löschung des TornPDA-Browsers durch `PDA_storage` erhalten.

## Reihenfolge der Umsetzung

**Phase A — belastbare Angriffs-Basis:** UI-Shell, Auth, Attack-Import/Paginierung, Deduplikation, Tages-/Wochen-/Monatsdiagramm, Täterranking, Heatmap, Quick-Link Blacklist. Mit Limited-Key funktionsfähig.

**Phase B — Geld:** Full-Log-Zugriff, Logtyp-Entdeckung, defensiver Mugging-Parser + Test anhand anonymisierter Echtdaten, Matching, Verlust-KPIs.

**Phase C — Standort:** Reise-Log-Parser, Intervallbildung, Torn vs. Abroad, Expositionsraten, Coverage-Kontrollen.

**Phase D — Qualität:** Backup/Import, Fehlerindikatoren, Datenqualitätsbericht, Regressionstests mit realen Logs.

## Quellenstand

- Offizielles Torn OpenAPI v2: https://www.torn.com/swagger/openapi.json
- Torn API-Schlüssel und Limits: https://www.torn.com/api.html
- TornPDA Javascript API: https://github.com/Manuito83/torn-pda/blob/master/userscripts/README.md
- TornPDA permanenter Script-Speicher: https://github.com/Manuito83/torn-pda/blob/master/userscripts/TornPDA_Storage.md
- Torn Enemies List und Einkaufsblockade: https://wiki.torn.com/wiki/Enemies_List