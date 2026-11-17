# Corporate Benefits Helper

Eine inoffizielle Chrome-Erweiterung für berechtigte Nutzerinnen und Nutzer von Corporate Benefits. Sie zeigt beim Besuch eines Shops passende Mitarbeiterangebote an. Im Erweiterungsmenü kannst du den Katalog durchsuchen, Gutscheincodes abrufen und verfügbare Aktionslinks oder Filialgutscheine öffnen.

## In Chrome installieren

1. Öffne dieses Repository auf GitHub und wähle **Code → Download ZIP**. Entpacke die ZIP-Datei an einem Ort, an dem der Ordner bleiben kann. Alternativ kannst du das Repository klonen.

   ```bash
   git clone https://github.com/tomschneider1/corporate-benefits-browser-extension.git
   ```

2. Gib `chrome://extensions/` in die Chrome-Adressleiste ein und aktiviere oben rechts den **Entwicklermodus**.
3. Klicke auf **Entpackte Erweiterung laden** und wähle den Unterordner `extension/` aus. Darin liegt die Datei `manifest.json`.
4. Öffne **Corporate Benefits Helper** über das Puzzle-Symbol neben der Adressleiste. Über die Stecknadel kannst du das Symbol dauerhaft anzeigen.
5. Gib unter **Unternehmensportal** die Portaladresse deines Arbeitgebers ein, beispielsweise `https://<unternehmen>.mitarbeiterangebote.de`. Ersetze `<unternehmen>` durch den Namen aus deiner tatsächlichen Portaladresse und klicke auf **Speichern**.
6. Öffne im Erweiterungsmenü **Portal öffnen** und melde dich im selben Chrome-Profil mit deinem eigenen berechtigten Konto an. Öffne anschließend die Erweiterung erneut und klicke auf **↻ Sync**.
7. Öffne oder aktualisiere einen Shop-Tab. Bei einem Treffer zeigt die Erweiterung die Zahl der gefundenen Angebote am Symbol und ein Banner auf der Seite. Über das Suchfeld im Erweiterungsmenü findest du auch Angebote, die sich keiner Shop-Domain direkt zuordnen lassen.

Zum Laden der Erweiterung genügt eine aktuelle Chrome-Version. `extension/` enthält alle Laufzeitdateien. Für Microsoft Edge findest du dieselben Installationsschritte unter `edge://extensions/`. [Chrome-Dokumentation](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked), [Edge-Dokumentation](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading)

### Aktualisieren und entfernen

- **Aktualisieren:** Führe im geklonten Ordner `git pull` aus oder ersetze den Inhalt des vorhandenen Ordners durch die neu entpackten Dateien. Klicke unter `chrome://extensions/` bei der Erweiterung auf **Neu laden** und aktualisiere offene Shop-Tabs.
- **Portal wechseln:** Öffne **Unternehmensportal** im Erweiterungsmenü, speichere die neue Adresse und wiederhole Anmeldung und Synchronisation. Kataloge bleiben pro Portal getrennt. Beim Wechsel verwirft die Erweiterung bisherige Gutscheincodes.
- **Entfernen:** Wähle unter `chrome://extensions/` bei der Erweiterung **Entfernen**. Chrome löscht dabei den lokalen Erweiterungsspeicher.

### Wenn etwas nicht klappt

- **Manifest fehlt:** Wähle den Unterordner `extension/`, in dem `manifest.json` liegt.
- **Anmeldung erforderlich:** Prüfe unter **Unternehmensportal** die Adresse, melde dich dort im selben Browserprofil an und starte **Sync** erneut.
- **Kein Banner:** Lade den Shop-Tab nach Installation oder Portalwechsel neu und prüfe das Suchfeld im Popup. Manche Angebote verwenden eine andere Shop-Adresse oder gelten nur über einen Aktionslink.
- **Entwicklermodus oder Installation gesperrt:** Auf einem verwalteten Arbeitsgerät kann eure Browser-Richtlinie das lokale Laden von Erweiterungen verhindern.

## Berechtigungen und Daten

- **Websites und Tabs:** Die Erweiterung prüft HTTP- und HTTPS-Tabs auf passende Angebote und kann auf passenden Seiten ein Banner anzeigen. Darum sind die Website-Berechtigungen breit gefasst.
- **Anfragen an Corporate Benefits:** Die Erweiterung verwendet die bestehende Anmeldung im Browser für Katalog, Angebotsdetails und den manuellen Codeabruf. Die Zuordnung von Shop-Domains und die Suche im Popup beginnen lokal. Für passende Angebote kann die Erweiterung Details beim Portal laden. Einen eingegebenen Suchbegriff sendet sie erst nach einem Klick auf **Im Unternehmensportal suchen** an das Portal.
- **Lokale Daten:** Portaladresse, Angebotsdaten, Ergebnisse der Domain-Prüfung und Sitzungsstatus liegen im lokalen Erweiterungsspeicher. Die Erweiterung erfasst keine Passwörter und betreibt keinen eigenen Server.
- **Gutscheincodes und Cookies:** Codes erscheinen ausschließlich im Erweiterungsmenü und bleiben höchstens für die aktuelle Browsersitzung im geschützten Sitzungsspeicher. Die Erweiterung verwendet einen lokalen Fingerabdruck der Cookies des eingestellten Portals, um Sitzungswechsel zu erkennen, und verwirft die Codes bei erkanntem Sitzungswechsel, Abmeldung oder Portalwechsel. Sie speichert keine Cookie-Werte.
- **Hintergrund:** Die Erweiterung verwendet Browser-Alarme zur Katalogaktualisierung und ein unsichtbares Erweiterungsdokument zum Parsen der Portalantworten.

Verwende die Erweiterung mit deinem eigenen berechtigten Konto. Behandle Gutschein- und Zugangscodes, Angebotsdetails und personalisierte Links vertraulich. Melde Fehler mit nachgestellten Beispielen und ohne echte Portaldaten. [Nutzungsbedingungen von Corporate Benefits](https://ihre.mitarbeiterangebote.de/meta/termsofuse)

## Entwicklung

Der Service Worker unter `extension/src/background.js` verwaltet Katalog, Zuordnung der Shops und Gutscheinabruf. Die Portal-Kommunikation und die HTML-Parser liegen in `extension/src/lib/`.

Tests mit Node.js 24 ausführen:

```bash
npm ci
npm test
```

Die Tests verwenden synthetische Portalantworten. Änderungen an der Portaloberfläche oder an den internen Schnittstellen können Anpassungen am Parser erforderlich machen.


## Lizenz

Der Code steht unter der [MIT License mit Commons Clause v1.0](LICENSE). Du darfst die Erweiterung nutzen, verändern, weiterentwickeln und kostenlos weitergeben, wenn die Lizenz- und Urheberrechtshinweise erhalten bleiben. Die Commons Clause schließt den Verkauf im dort definierten Sinn aus. Das erfasst auch entgeltliche Angebote, deren Wert wesentlich auf dieser Software beruht. Das Projekt ist damit *source-available*. [Commons Clause](https://commonsclause.com/)
