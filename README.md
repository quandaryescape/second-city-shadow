# Second City Shadow

A pack-and-play escape room: players use their phones as a field-ops terminal,
and solving puzzles drives physical props over the local network.

| Folder | What it is |
|---|---|
| [`app/`](app/) | Node server, phone player app, host console, and the visual Setup Console for editing every puzzle, answer, media file, and webhook. See [app/README.md](app/README.md). |
| [`esp32/hack_lights/`](esp32/hack_lights/) | ESP32 + WS2812B firmware for the HACK light panel — receives the hack webhook and displays the light pattern. See [esp32/hack_lights/README.md](esp32/hack_lights/README.md). |

## Quick start

```bash
cd app
npm install
npm start
```

Open `http://<server-ip>:3000/admin.html` to create a room, `/setup.html` to
edit content, and have players visit `http://<server-ip>:3000/`.

For the light panel, copy `esp32/hack_lights/secrets.example.h` to `secrets.h`,
add your WiFi credentials, and flash with the FastLED library installed.
