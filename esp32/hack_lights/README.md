# HACK light panel (ESP32 + WS2812B)

Receives the hack webhook from `app/server.js` and shows the 6-bit light
pattern the players have to decode.

## What it shows

The panel is a map of the six toggle switches — three across the top, three
across the bottom — telling players which ones to flip up.

So the code is drawn as a tight **3-bit group** on the top strip with its
matching 3-bit group directly below it on the bottom strip, and that whole
group repeats three times along the strips so it reads from anywhere along
the case. Pattern `101001` (top `101`, bottom `001`) renders as:

```
top     ----### ... ###-------### ... ###-------### ... ###----
bottom  ----... ... ###-------... ... ###-------... ... ###----
         edge  group   sep       group   sep       group  edge
```

| Element | Width | Default colour | Meaning |
|---|---|---|---|
| `#` bit = 1 | 3 LEDs | bright green | flip this switch ON |
| `.` bit = 0 | 3 LEDs | dim red | leave this switch OFF |
| ` ` slit | 1 LED | off | divides bits inside a group |
| `-` separator | 7 LEDs (4 at the ends) | dim blue | divides one group from the next |

The narrow dark slit matters: without it two adjacent ON bits would merge into
one long green run and `110` would be unreadable. The wide solid separator only
ever appears *between* groups, so each group stays a single readable chunk.

Widths add up to exactly 55 (`4 + 11 + 7 + 11 + 7 + 11 + 4`), so a row divides
with no rounding and the top and bottom groups line up perfectly. Both rows use
the same layout, which is what keeps each top block directly above its partner.

Bit order matches the app exactly: `bit1`–`bit3` are the top row left to right
(`lights[0..2]`, `mask` bits 0–2), `bit4`–`bit6` the bottom row
(`lights[3..5]`, `mask` bits 3–5). Those are the cells labelled **L1**–**L6**
in the Setup Console under **HACK → ESP32 LIGHT PATTERN**, and they map
left-to-right onto the switches in each row.

## Wiring

| ESP32 | Strip / PSU |
|---|---|
| GPIO13 | 330 Ω resistor → strip **DIN** |
| GND | strip GND **and** PSU GND (must be common) |
| — | 5 V PSU → strip 5 V |
| 5 V / VIN | from the same PSU (do **not** power 110 LEDs off USB) |

Also add a 1000 µF capacitor across the strip's 5 V/GND at the input end.

**Power:** 110 WS2812B at full white is roughly 6.6 A. The sketch caps
brightness at 80/255 and hands FastLED a 2.5 A budget, which is comfortable on
a 5 V 3 A supply. Raise `BRIGHTNESS` / `PSU_MILLIAMPS` together only if your
supply can take it, and inject 5 V at both ends of a 110-pixel run so the far
end doesn't go pink.

## Setup

Set up WiFi, then edit the CONFIG block at the top of `hack_lights.ino`:

1. Copy `secrets.example.h` to `secrets.h` and fill in `WIFI_SSID_VALUE` /
   `WIFI_PASS_VALUE`. `secrets.h` is git-ignored, so your password stays out of
   the repo.
2. `IP_ADDR` — must match the URL in `app/config/puzzles.json`
   (`esp32.hackWebhook`, currently `http://192.168.1.50/trigger/hack`), and
   `IP_GATEWAY` / `IP_SUBNET` / `IP_DNS` must match your router. Set
   `USE_STATIC_IP 0` if you'd rather use a DHCP reservation.
3. `LED_PIN`, `NUM_LEDS`, `ROW_LEN`, `BOTTOM_START` if your strip differs.
4. `BOTTOM_ROW_REVERSED 1` if the strip snakes back right-to-left, so the
   bottom row reads left-to-right like the top one.

Install **FastLED** from the Arduino Library Manager, select any ESP32 dev
board, and flash. No JSON library needed.

## Testing

The board serves a small page at its own address:

- `http://192.168.1.50/` — status plus a box to type any 6 bits and show them
- `http://192.168.1.50/trigger/hack?bits=101001` — show a pattern directly
- `http://192.168.1.50/reset` — back to the idle breathe
- `http://192.168.1.50/health` — JSON status

Fire the real webhook without playing a game: use the **FIRE** button next to
the hack webhook in the host console, or from the PC:

```bash
curl -X POST http://192.168.1.50/trigger/hack -H "Content-Type: application/json" -d "{\"event\":\"hack_complete\",\"room\":\"TEST\",\"bits\":\"101001\",\"rows\":2,\"cols\":3}"
```

`test-webhook.ps1` in this folder does the same and can sweep every pattern.

Serial monitor at 115200 prints the computed layout at boot and every webhook
it receives.

## Behaviour

- **Idle** — slow dim blue breathe across both rows.
- **Boot** — blue chase on the first pixels while connecting; one green flash
  when WiFi is up, three red flashes if it failed.
- **Webhook received** — 700 ms left-to-right wipe, then the pattern holds
  steady (steady, not pulsing, so it stays readable while players decode it).
- **Hold** — forever by default. Set `HOLD_MS` to e.g. `60000` to auto-return
  to idle after a minute; `/reset` clears it any time.

## Notes

- The sketch reads `bits`, then `lights`, then `pattern`, then `mask` — any one
  of them is enough, so trimming `esp32.hackPayload` won't break it. If none are
  present it shows `101010` and logs a warning.
- `hack.lightPattern` in `puzzles.json` is global, not per-room, so every kit on
  the server shows the same pattern. Per-room webhook *URLs* are still
  overridable in the host console, so two panels can run off one server.
- The endpoint accepts POST (what the app sends) and GET (for testing) on the
  same path.
- `GROUPS_PER_ROW` controls how many times the code repeats along the strip.
  Fewer repeats means bigger blocks — `2` gives 4-LED blocks, `1` gives 8-LED
  blocks spread across the whole row. The layout recomputes itself either way.
- If the LED groups don't line up over the switches, nudge `W_EDGE` (pushes the
  groups inward/outward) and `W_GROUP_GAP` (spreads them apart). The boot-time
  serial dump prints the exact LED index range of every block so you can measure
  against the real panel.
- Colours are all `CRGB` constants at the top. For unlit zeros instead of dim
  red markers, set `COLOR_OFF` to `CRGB::Black`.
