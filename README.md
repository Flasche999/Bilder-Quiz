
# Bildklick-Quiz (Node.js + Socket.IO)

## Start
```bash
npm init -y
npm i express socket.io
node server.js
```
- Moderator: http://localhost:10000/admin.html
- Spieler:    http://localhost:10000/player.html

## Features
- Moderator stellt Bild-URL, Sichtbarkeitsdauer, Klick-Radius und Zielbereich ein.
- Bild ist für Spieler nur kurz sichtbar, danach schwarz.
- Spieler wählen klickend eine Position; Radius-Vorschau sichtbar; mit "Eingabe" wird gelockt.
- Klicks sind geheim bis Moderator "Klicks zeigen" oder "Auswerten" drückt.
- Auswertung: alle Spieler im Zielkreis bekommen +5 Punkte.
- Reveal: Nur kreisförmige Sichtfenster rund um alle Klicks werden für alle sichtbar, der Rest bleibt schwarz.
- Musik: Moderator stellt globale Lautstärke; Spieler können lokal stummschalten. Lege deine MP3 unter /public/sfx/bg.mp3 ab.

## Demo-Bild
Ein Beispielbild liegt unter `public/images/sample.png`.
