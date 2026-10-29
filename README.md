# Torn Attack Intelligence – Hospital Dashboard

**Status:** v0.1.0, erste lauffähige Implementierung; echte TornPDA-/API-Kontodaten **noch nicht getestet**.

TornPDA-Userscript, das auf Torn's Hospital-Seiten (`/hospitalview.php` und `/hospital.php`) ein einklappbares, mobilfreundliches Dashboard **oberhalb der bestehenden Hospital-Liste** anzeigt.

## Funktionen

1. Eingehende Angriffe: Gesamtanzahl, Tages-, Wochen- und Monatsverlauf (UTC).
2. Geldverlust: bekannte Angreifer, anonyme Angreifer, nicht zuordenbare Mugging-Logs; unvollständige Beträge bleiben sichtbar unvollständig.
3. Wiederholungstäter ab zwei Angriffen: Spieler-ID, Name, Treffer, zugeordnete Verluste, letzter Angriff.
4. Torn City vs. Ausland: Zuordnung auf Basis des ab Installation gesammelten Standortverlaufs; fehlende Zuordnung separat.
5. Schneller Blacklist-Einstieg: Profil öffnen und **manuell** zur Enemies List hinzufügen; „Allow Exchanges“ deaktivieren.
6. Heatmap: Wochentag × UTC-Stunde.
7. Angriffe je 24 Stunden Aufenthaltszeit: nur für zuverlässig beobachtete Standort-Zeitfenster.

## Installation in TornPDA

1. Im TornPDA-Browser **Advanced Browser Settings → Manage Scripts** öffnen.
2. `attack-intelligence.user.js` als neues Userscript importieren, alternativ den **Raw**-Link einer GitHub-Datei benutzen.
3. Script aktivieren. Einen **Limited API Key** in TornPDA konfigurieren, der `/user/attacks` freigibt.
4. Für die genauen Geldbeträge zusätzlich **Custom API Key mit `/user/log`** (Log-Typ **8156 – Attack mug receive**) oder Full Access verwenden. Key **niemals** in den Code oder das Repository kopieren.
5. Torn-Browser öffnen: `https://www.torn.com/hospitalview.php`.
6. **↻ Aktualisieren** für den ersten Import, **⤓ Historie** für weitere Seiten. Es wird kein anderes Script verändert.

**Hinweis zum API-Key:** Das Script enthält nur den TornPDA-Platzhalter `###PDA-APIKEY###`. Dieser wird von TornPDA zur Laufzeit eingesetzt. `/user/log` benötigt andere Berechtigungen als `/user/attacks`; falls dein PDA-Key dafür keine Berechtigung hat, erscheinen Angriffe trotzdem, aber keine verifizierten Geldsummen.

## Technische Architektur

- Torn API v2 via **PDA_httpGet** und `Authorization: ApiKey ...` (nur `api.torn.com`, keine Fremdserver).
- `GET /user/attacks?filters=incoming&limit=100&sort=DESC`
- `GET /user/log?log=8156&limit=100` (optional)
- `GET /user/basic` und `GET /user/travel` zur Momentaufnahme des Aufenthalts.
- Per-Script-Datenspeicher: primär `PDA_storage`, Fallback `localStorage`.
- Duplicate-Handling über Attack-ID bzw. Log-ID.
- 3 API-Seiten beim normalen Sync, bis zu 12 mit Historie; bis maximal 365 Tage pro Abruf. Kein permanentes Polling.
- Mobile CSS mit eigenem `#tai-root`-Namespace. Keine externen JS-Bibliotheken.

## Einschränkungen und Datenqualität

- **Stealth:** Die Torn API liefert bei anonymen Angreifern keine eindeutige Player-ID. Anonyme Angriffe sind nicht zu identifizieren oder zu einer Person zusammenzufassen.
- **Mugging-Beträge:** Torn `/user/log` hat dynamische `data`-Felder. Das Script liest nur explizit bekannte Betrags-Schlüssel. Unbekannte Log-Formate werden **nicht** als `$0` interpretiert. Die Werte sind nach dem ersten echten API-Test zu validieren.
- **Zuordnung von Log/Attack:** Priorität hat die Attack-ID (soweit vorhanden), ansonsten zeitliche Näherung von maximal 120 Sekunden. Bei mehreren Kämpfen innerhalb kurzer Zeit ist eine falsche Zuordnung möglich. Nicht zuordenbare Logs bleiben separat.
- **Historische Standortquoten:** Das offizielle Travel-API bietet nicht automatisch eine vollständige rückwirkende Reisechronik. Aus den ab Scriptinstallation gesammelten Standort-Samples werden nur **aufeinanderfolgende identische Samples** bis 60 Minuten Abstand als Aufenthaltszeit gewertet. Unbeobachtete Vergangenheit wird nicht geschätzt. Historisch nicht eindeutig zuordenbare Angriffe werden als „Unbekannt“ gezählt.
- **Blacklist:** Die API ist read-only. Der Profil-Link ist ein manueller Shortcut – keine automatische Aufnahme in die Enemies List. Der Bazaar-Schalter „Allow Exchanges“ gilt für die gesamte Enemies List.
- **Reichweite:** Das Script wird nur auf den zwei Hospital-Pfaden aktiv, nicht beim normalen Aufenthalt in anderen Torn-Seiten. Deshalb ist Standortabdeckung zunächst lückenhaft. Für genaue Quoten wäre in v0.2.0 ein seitenübergreifender, sparsamer Hintergrund-Sampler sinnvoll.
- **Nicht produktiv getestet:** Das Script wurde syntaktisch mit Node.js geprüft. Keine realen Torn-API-Keys oder Live-UI-Tests liegen vor.

## GitHub-Repository

Das Repository liegt unter [PatchPilotGer/torn-attack-intelligence](https://github.com/PatchPilotGer/torn-attack-intelligence). Die Version 0.1.0 ist eine technisch geprüfte Vorabversion und benötigt einen echten TornPDA-Livetest.

Raw-Installationslink:

`https://raw.githubusercontent.com/PatchPilotGer/torn-attack-intelligence/main/attack-intelligence.user.js`

## Quellen

- [Offizielle Torn API v2 / Swagger](https://www.torn.com/swagger.php)
- [TornPDA Userscripts](https://github.com/Manuito83/torn-pda/tree/master/userscripts)
- [TornPDA Storage API](https://github.com/Manuito83/torn-pda/blob/master/userscripts/TornPDA_Storage.md)
- [TornPDA GET API](https://github.com/Manuito83/torn-pda/blob/master/userscripts/TornPDA_API.js)

## Sicherheit

Nur selbst überprüfte Scripts installieren. Keine API-Keys in Issues oder Screenshots posten; wenn nötig, sensible Werte vorher schwärzen. Keine GitHub Actions oder Telemetrie, kein automatisiertes Blockieren oder Angreifen.

## Offline-Test

`node --check attack-intelligence.user.js` und `node test/mock-smoke.test.cjs`

Der Mock-Test prüft Hospital-Einblendung, getrennte API-Abrufe, Wiederholungstäter, anonyme Geldverluste und persistente Speicherung. Dies ersetzt keinen Live-Test mit TornPDA.