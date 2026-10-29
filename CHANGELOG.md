## v0.1.4 – 2026-10-29

- Fix: Der tatsächliche Geldverlust aus dem Mugging-Log 8156 liegt in `data.money_mugged`; Feld jetzt korrekt auslesen.
- Bisherige Logs mit unbekannten Beträgen werden beim nächsten Refresh erneut eingelesen, ohne Duplikate anzulegen.
- Kontrast der Angreifertabelle auf mobilen Geräten verbessert.
- Offline-Test mit zwei Mugging-Logs und Beträgen (5.000 / 2.000 Torn-Dollar) erfolgreich: Gesamtsumme 7.000, bekannte/anonyme Täter getrennt.

## v0.1.3 – 2026-10-29

- Standortsamples auch beim Besuch anderer Torn-Seiten im Hintergrund (maximal ein neuer Abgleich je 15 Minuten); das Dashboard selbst erscheint weiterhin nur im Hospital.
- Fehlende Offline-Zeit bleibt unbekannt, keine künstlich hochgerechneten Aufenthaltsstunden.

## v0.1.2 – 2026-10-29

- Zeigt jetzt alle identifizierten Angreifer mit Profil-Link, nicht nur Wiederholungstäter; Mehrfachtäter werden mit Stern markiert.
- Kennzeichnet fehlende Mugging-Logberechtigungen und Geldbeträge als „—“ statt irreführend als $0.
- Zeigt den Zeitpunkt und Umfang vorhandener Standort-Beobachtungen an.
- Erkennt den offiziellen API-Heimatort `Torn` als Torn City und unterstützt verschachtelte sowie direkte Basis-API-Antworten.
- Heatmap-Legende korrigiert: heller bedeutet häufiger.

# Changelog

## 0.1.0 – 2026-10-29

- Erste Hospital-Einbettung für TornPDA.
- 24h/7d/30d/Gesamt-Auswertung und Tag/Woche/Monat.
- Wiederholungstäter-Liste mit Profil-Shortcut.
- Mugging-Log-Import (optional bei log-berechtigtem API-Key), Verlusttrennung.
- UTC-Heatmap, Standort-Samples und Expositionsquoten.
- Lokaler Speicher mit Duplikatschutz.
- Noch nicht mit einem echten TornPDA-Konto validiert.