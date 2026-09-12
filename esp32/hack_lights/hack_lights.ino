/*
  The Quandary - HACK light panel
  ---------------------------------------------------------------------------
  Listens for the hack webhook fired by app/server.js and paints the 6-bit
  light pattern onto two rows of WS2812B.

  The server POSTs (see app/README.md "ESP32 integration"):

    POST /trigger/hack
    Content-Type: application/json
    { "event":"hack_complete", "room":"7K2P",
      "pattern":[[1,0,1],[0,1,0]], "lights":[1,0,1,0,1,0],
      "bits":"101010", "mask":21, "rows":2, "cols":3 }

  Light order is row-major: lights[0..2] = top row left->right,
  lights[3..5] = bottom row left->right. This sketch reads whichever field it
  finds first (bits -> lights -> pattern -> mask), so it keeps working if the
  payload is ever trimmed down.

  Strip layout: one continuous 110-LED run.
      index   0 .. 54  -> TOP row
      index  55 ..109  -> BOTTOM row

  The panel is a map of the six toggle switches: three across the top row,
  three across the bottom, each LED block sitting in line with its switch.
  So the six bits are drawn as a tight 3-bit group on the top strip with its
  matching 3-bit group directly below it on the bottom strip, and that whole
  group is repeated along the strip so the code reads from anywhere:

      top     ----### ... ###-------### ... ###-------### ... ###----
      bottom  ----... ... ###-------... ... ###-------... ... ###----
               edge  group   sep       group   sep       group  edge

  Bits inside a group are separated only by a narrow dark slit, so the group
  reads as one chunk; the wide solid separator colour only ever appears
  between groups. Without the slit two adjacent ON bits would merge into one
  long run and the code would be ambiguous.

  Board: any ESP32 dev module.  Libraries: FastLED (Arduino Library Manager).
  No JSON library needed.
*/

#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <FastLED.h>

// ===========================================================================
//  CONFIG - everything you normally need to touch lives in this block
// ===========================================================================

// ---- WiFi ----
// Real credentials go in secrets.h (copy secrets.example.h). secrets.h is
// git-ignored so a password never lands in the repo; without it the sketch
// still compiles using these placeholders.
#if __has_include("secrets.h")
#include "secrets.h"
#else
#define WIFI_SSID_VALUE "YOUR_WIFI_SSID"
#define WIFI_PASS_VALUE "YOUR_WIFI_PASSWORD"
#endif
static const char *WIFI_SSID = WIFI_SSID_VALUE;
static const char *WIFI_PASS = WIFI_PASS_VALUE;

// The webhook URL in app/config/puzzles.json is http://192.168.1.50/trigger/hack
// so this board must always land on that address. Leave USE_STATIC_IP on, or
// set a DHCP reservation in your router and turn it off.
#define USE_STATIC_IP 1
static const IPAddress IP_ADDR(192, 168, 1, 50);
static const IPAddress IP_GATEWAY(192, 168, 1, 1);
static const IPAddress IP_SUBNET(255, 255, 255, 0);
static const IPAddress IP_DNS(192, 168, 1, 1);

#define MDNS_NAME "quandary-hack"   // also reachable at quandary-hack.local

// ---- LEDs ----
#define LED_PIN        13     // data pin -> 330R -> strip DIN
#define NUM_LEDS       110    // 55 top + 55 bottom
#define ROW_LEN        55
#define TOP_START      0      // first index of the top row
#define BOTTOM_START   55     // first index of the bottom row
#define BOTTOM_ROW_REVERSED 0 // set to 1 if the strip snakes back right-to-left
#define LED_TYPE       WS2812B
#define COLOR_ORDER    GRB

// 110 pixels at full white is ~6.6 A. Keep the brightness cap and the power
// limiter unless you are running a beefy 5 V supply with injection at both ends.
#define BRIGHTNESS     80     // 0-255
#define PSU_VOLTS      5
#define PSU_MILLIAMPS  2500

// ---- Colours ----
// A "1" block is bright (flip that switch), a "0" block is a dim marker so
// players can still see where the block is and count positions.
// Want unlit zeros instead? set COLOR_OFF to CRGB::Black.
static const CRGB COLOR_ON   = CRGB(0, 255, 70);  // bit = 1, switch ON  (green)
static const CRGB COLOR_OFF  = CRGB(60, 0, 0);    // bit = 0, switch OFF (dim red)
static const CRGB COLOR_GAP  = CRGB::Black;       // narrow slit between bits in a group
static const CRGB COLOR_SEP  = CRGB(0, 0, 45);    // wide fill between groups (dim blue)
static const CRGB COLOR_IDLE = CRGB(0, 0, 40);    // breathing colour while waiting

// ---- Geometry ----
// Relative widths. With GROUPS_PER_ROW = 3 and cols = 3 these add up to
// exactly 55, so the row divides with no rounding:
//   4 + (3+1+3+1+3) + 7 + (3+1+3+1+3) + 7 + (3+1+3+1+3) + 4 = 55
// Fewer groups means bigger blocks: 2 groups -> 4 LEDs each, 1 -> 8 LEDs each.
#define GROUPS_PER_ROW  3     // how many times the 3-bit code repeats along the row
#define W_BLOCK         3     // width of one bit block
#define W_BIT_GAP       1     // dark slit between bits inside a group
#define W_GROUP_GAP     7     // solid separator between groups
#define W_EDGE          4     // solid separator at the two row ends

// ---- Timing ----
#define REVEAL_MS   700       // left-to-right wipe when the pattern appears
#define HOLD_MS     0         // how long to hold the pattern; 0 = until /reset

// ---- Limits ----
#define MAX_ROWS    2
#define MAX_COLS    8
#define MAX_BLOCKS  (MAX_COLS * 4)
#define MAX_SEGS    (2 * MAX_BLOCKS + 1)

// ===========================================================================

CRGB leds[NUM_LEDS];
WebServer server(80);

// --- current pattern state ---
uint8_t  g_bits[MAX_ROWS][MAX_COLS];
uint8_t  g_rows = MAX_ROWS;
uint8_t  g_cols = 3;
bool     g_hasPattern = false;
uint32_t g_showStart = 0;
String   g_room = "";
String   g_lastBits = "";

// --- row segmentation ---
enum SegKind : uint8_t { SEG_BLOCK, SEG_BIT_GAP, SEG_GROUP_GAP, SEG_EDGE };

struct Seg {
  uint16_t start;
  uint16_t len;
  SegKind  kind;
  uint8_t  bitIndex;     // which of the 3 bits this block shows; 0xFF for gaps
};
Seg      g_segs[MAX_SEGS];
uint8_t  g_segCount = 0;

// ---------------------------------------------------------------------------
//  Tiny tolerant JSON readers. The payload is small and fixed-shape, so this
//  avoids pulling in ArduinoJson and its v6/v7 API split.
// ---------------------------------------------------------------------------
static int valueStart(const String &b, const char *key) {
  String needle = String("\"") + key + "\"";
  int i = b.indexOf(needle);
  if (i < 0) return -1;
  i += needle.length();
  while (i < (int)b.length() && isSpace(b[i])) i++;
  if (i >= (int)b.length() || b[i] != ':') return -1;
  i++;
  while (i < (int)b.length() && isSpace(b[i])) i++;
  return (i < (int)b.length()) ? i : -1;
}

static bool jsonString(const String &b, const char *key, String &out) {
  int i = valueStart(b, key);
  if (i < 0 || b[i] != '"') return false;
  int j = b.indexOf('"', i + 1);
  if (j < 0) return false;
  out = b.substring(i + 1, j);
  return true;
}

static bool jsonLong(const String &b, const char *key, long &out) {
  int i = valueStart(b, key);
  if (i < 0) return false;
  int j = i;
  if (b[j] == '-' || b[j] == '+') j++;
  int firstDigit = j;
  while (j < (int)b.length() && isDigit(b[j])) j++;
  if (j == firstDigit) return false;
  out = b.substring(i, j).toInt();
  return true;
}

// Pulls every 0/1 out of an array value, flat or nested, so "pattern"
// ([[1,0,1],[0,1,0]]) and "lights" ([1,0,1,0,1,0]) both yield "101010".
static bool jsonBinaryDigits(const String &b, const char *key, String &out) {
  int i = valueStart(b, key);
  if (i < 0 || b[i] != '[') return false;
  int depth = 0;
  out = "";
  for (int j = i; j < (int)b.length(); j++) {
    char c = b[j];
    if (c == '[') depth++;
    else if (c == ']') { if (--depth == 0) return out.length() > 0; }
    else if (c == '0' || c == '1') out += c;
  }
  return false;
}

// ---------------------------------------------------------------------------
//  Layout: carve one row into alternating gap / block segments.
//
//  Segments run gap, block, gap, block, ... gap. A gap is an EDGE at either
//  end of the row, a GROUP_GAP where one 3-bit group ends and the next
//  begins (every cols-th gap), or a narrow BIT_GAP between bits of the same
//  group. Both rows use this same layout, which is what keeps each top block
//  sitting directly above its partner on the bottom strip.
// ---------------------------------------------------------------------------
void buildLayout(uint8_t cols) {
  uint8_t blocks = cols * GROUPS_PER_ROW;
  if (blocks > MAX_BLOCKS) blocks = MAX_BLOCKS;
  g_segCount = 2 * blocks + 1;

  uint16_t w[MAX_SEGS];
  uint32_t totalW = 0;
  for (uint8_t i = 0; i < g_segCount; i++) {
    if (i & 1) {
      g_segs[i].kind = SEG_BLOCK;
      w[i] = W_BLOCK;
    } else {
      uint8_t gap = i / 2;                  // 0 = left edge, blocks = right edge
      if (gap == 0 || gap == blocks)  { g_segs[i].kind = SEG_EDGE;      w[i] = W_EDGE; }
      else if (gap % cols == 0)       { g_segs[i].kind = SEG_GROUP_GAP; w[i] = W_GROUP_GAP; }
      else                            { g_segs[i].kind = SEG_BIT_GAP;   w[i] = W_BIT_GAP; }
    }
    totalW += w[i];
  }

  // Spread the 55 pixels across those weights so the row is filled exactly.
  uint32_t cum = 0;
  uint16_t prev = 0;
  for (uint8_t i = 0; i < g_segCount; i++) {
    cum += w[i];
    uint16_t pos = (uint16_t)((cum * (uint32_t)ROW_LEN + totalW / 2) / totalW);
    if (pos > ROW_LEN) pos = ROW_LEN;
    if (pos < prev) pos = prev;
    g_segs[i].start    = prev;
    g_segs[i].len      = pos - prev;
    g_segs[i].bitIndex = (g_segs[i].kind == SEG_BLOCK)
                       ? (uint8_t)(((i - 1) / 2) % cols) : 0xFF;
    prev = pos;
  }
}

// ---------------------------------------------------------------------------
//  Pixel helpers
// ---------------------------------------------------------------------------
inline void setRowPixel(uint8_t row, uint16_t col, const CRGB &c) {
  if (col >= ROW_LEN) return;
  uint16_t idx;
  if (row == 0) {
    idx = TOP_START + col;
  } else {
#if BOTTOM_ROW_REVERSED
    idx = BOTTOM_START + (ROW_LEN - 1 - col);
#else
    idx = BOTTOM_START + col;
#endif
  }
  if (idx < NUM_LEDS) leds[idx] = c;
}

// revealCols limits how far in from the left each row has been painted.
void renderPattern(uint16_t revealCols) {
  fill_solid(leds, NUM_LEDS, CRGB::Black);
  for (uint8_t row = 0; row < MAX_ROWS; row++) {
    for (uint8_t s = 0; s < g_segCount; s++) {
      CRGB c;
      switch (g_segs[s].kind) {
        case SEG_BLOCK: {
          bool on = (row < g_rows) && g_bits[row][g_segs[s].bitIndex];
          c = on ? COLOR_ON : COLOR_OFF;
          break;
        }
        case SEG_BIT_GAP: c = COLOR_GAP; break;
        default:          c = COLOR_SEP; break;   // SEG_GROUP_GAP, SEG_EDGE
      }
      for (uint16_t k = 0; k < g_segs[s].len; k++) {
        uint16_t col = g_segs[s].start + k;
        if (col < revealCols) setRowPixel(row, col, c);
      }
    }
  }
  FastLED.show();
}

void renderIdle() {
  uint8_t b = 12 + (uint8_t)(quadwave8(millis() / 14) / 6);   // slow breath
  CRGB c = COLOR_IDLE;
  c.nscale8_video(b);
  fill_solid(leds, NUM_LEDS, c);
  FastLED.show();
}

void flashAll(const CRGB &c, uint8_t times, uint16_t onMs) {
  for (uint8_t i = 0; i < times; i++) {
    fill_solid(leds, NUM_LEDS, c);
    FastLED.show();
    delay(onMs);
    FastLED.clear(true);
    delay(onMs);
  }
}

// ---------------------------------------------------------------------------
//  Pattern application
// ---------------------------------------------------------------------------
void applyBits(const String &bits, uint8_t rows, uint8_t cols) {
  if (cols == 0 || cols > MAX_COLS) cols = 3;
  if (rows == 0) rows = 1;
  if (rows > MAX_ROWS) {
    Serial.printf("[hack] payload had %u rows, panel has %u - extra rows ignored\n",
                  rows, (unsigned)MAX_ROWS);
    rows = MAX_ROWS;
  }

  g_rows = rows;
  g_cols = cols;
  memset(g_bits, 0, sizeof(g_bits));

  uint16_t need = (uint16_t)rows * cols;
  if (bits.length() < need) {
    Serial.printf("[hack] only %u of %u bits supplied - padding with 0\n",
                  bits.length(), need);
  }
  for (uint16_t i = 0; i < need && i < bits.length(); i++) {
    g_bits[i / cols][i % cols] = (bits[i] == '1') ? 1 : 0;
  }

  buildLayout(cols);
  g_lastBits = bits.substring(0, min((unsigned)need, (unsigned)bits.length()));
  g_hasPattern = true;
  g_showStart = millis();

  Serial.printf("[hack] pattern %ux%u  top=%u%u%u  bottom=%u%u%u  room=%s\n",
                rows, cols,
                g_bits[0][0], g_bits[0][1], g_bits[0][2],
                g_bits[1][0], g_bits[1][1], g_bits[1][2],
                g_room.c_str());
}

// Reads the pattern out of a webhook body. Priority: bits, lights, pattern, mask.
bool applyPayload(const String &body) {
  long rows = 2, cols = 3, mask = 0;
  jsonLong(body, "rows", rows);
  jsonLong(body, "cols", cols);
  if (!jsonString(body, "room", g_room)) g_room = "";

  String bits;
  if (jsonString(body, "bits", bits)) {
    String clean;                     // tolerate spacing, e.g. "1 0 1 0 1 0"
    for (uint16_t i = 0; i < bits.length(); i++)
      if (bits[i] == '0' || bits[i] == '1') clean += bits[i];
    bits = clean;
  }
  if (!bits.length()) jsonBinaryDigits(body, "lights", bits);
  if (!bits.length()) jsonBinaryDigits(body, "pattern", bits);
  if (!bits.length() && jsonLong(body, "mask", mask)) {
    uint16_t need = (uint16_t)rows * (uint16_t)cols;
    for (uint16_t i = 0; i < need; i++) bits += ((mask >> i) & 1) ? '1' : '0';
  }
  if (!bits.length()) return false;

  applyBits(bits, (uint8_t)rows, (uint8_t)cols);
  return true;
}

// ---------------------------------------------------------------------------
//  HTTP handlers
// ---------------------------------------------------------------------------
String statusJson() {
  String s = "{\"ok\":true,\"device\":\"" MDNS_NAME "\",\"ip\":\"";
  s += WiFi.localIP().toString();
  s += "\",\"armed\":";
  s += g_hasPattern ? "true" : "false";
  s += ",\"bits\":\"" + g_lastBits + "\"";
  s += ",\"rows\":" + String(g_rows) + ",\"cols\":" + String(g_cols);
  s += ",\"room\":\"" + g_room + "\"";
  s += ",\"uptimeMs\":" + String(millis()) + "}";
  return s;
}

void handleHack() {
  String body = server.hasArg("plain") ? server.arg("plain") : String("");

  // Browser-friendly test path: /trigger/hack?bits=101001
  if (!body.length() && server.hasArg("bits")) {
    body = String("{\"bits\":\"") + server.arg("bits") + "\",\"rows\":2,\"cols\":3}";
  }

  Serial.printf("[hack] %s %s body=%s\n",
                server.method() == HTTP_POST ? "POST" : "GET",
                server.uri().c_str(), body.c_str());

  if (!applyPayload(body)) {
    Serial.println("[hack] no pattern field in body - showing default 101010");
    g_room = "";
    applyBits("101010", 2, 3);
    server.send(200, "application/json",
                "{\"ok\":true,\"note\":\"no pattern in body, used default\"}");
    return;
  }
  server.send(200, "application/json", statusJson());
}

void handleReset() {
  g_hasPattern = false;
  g_lastBits = "";
  g_room = "";
  Serial.println("[hack] reset -> idle");
  server.send(200, "application/json", "{\"ok\":true,\"armed\":false}");
}

void handleRoot() {
  String h = F("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
               "<style>body{font:14px system-ui;background:#111;color:#ddd;padding:24px;max-width:34rem}"
               "code,input{font:13px ui-monospace;background:#000;color:#7f7;border:1px solid #333;padding:4px 6px}"
               "button{font:13px system-ui;padding:6px 12px}</style>"
               "<h2>Quandary &middot; HACK light panel</h2>");
  h += "<p>Status: <code>" + statusJson() + "</code></p>";
  h += F("<form action='/trigger/hack' method='get'>"
         "<p>Test pattern (6 bits: top row then bottom row)<br>"
         "<input name='bits' value='101001' maxlength='8'> "
         "<button type='submit'>Show</button></p></form>"
         "<form action='/reset' method='get'><button type='submit'>Reset to idle</button></form>"
         "<p>Webhook endpoint: <code>POST /trigger/hack</code></p>");
  server.send(200, "text/html", h);
}

// ---------------------------------------------------------------------------
//  WiFi
// ---------------------------------------------------------------------------
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
#if USE_STATIC_IP
  if (!WiFi.config(IP_ADDR, IP_GATEWAY, IP_SUBNET, IP_DNS)) {
    Serial.println("[net] static IP config failed, falling back to DHCP");
  }
#endif
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[net] connecting to %s", WIFI_SSID);

  uint32_t start = millis();
  uint8_t spin = 0;
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    FastLED.clear();                         // blue chase while we wait
    for (uint8_t i = 0; i < 4; i++) leds[(spin + i) % 12] = CRGB(0, 0, 30 + i * 20);
    FastLED.show();
    spin = (spin + 1) % 12;
    delay(120);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[net] up at %s\n", WiFi.localIP().toString().c_str());
    if (MDNS.begin(MDNS_NAME)) {
      MDNS.addService("http", "tcp", 80);
      Serial.println("[net] mDNS: http://" MDNS_NAME ".local/");
    }
    flashAll(CRGB(0, 40, 0), 1, 150);
  } else {
    Serial.println("[net] FAILED - check SSID, password, and the static IP range");
    flashAll(CRGB(40, 0, 0), 3, 150);
  }
}

// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== Quandary HACK light panel ===");

  FastLED.addLeds<LED_TYPE, LED_PIN, COLOR_ORDER>(leds, NUM_LEDS)
         .setCorrection(TypicalLEDStrip);
  FastLED.setBrightness(BRIGHTNESS);
  FastLED.setMaxPowerInVoltsAndMilliamps(PSU_VOLTS, PSU_MILLIAMPS);
  FastLED.clear(true);

  buildLayout(3);
  static const char *KIND_NAME[] = { "BIT", "slit", "sep", "edge" };
  for (uint8_t i = 0; i < g_segCount; i++) {
    Serial.printf("[layout] seg%-2u %-4s cols %2u..%-2u len %2u", i,
                  KIND_NAME[g_segs[i].kind],
                  g_segs[i].start, g_segs[i].start + g_segs[i].len - 1,
                  g_segs[i].len);
    if (g_segs[i].kind == SEG_BLOCK) Serial.printf("  bit %u", g_segs[i].bitIndex + 1);
    Serial.println();
  }

  connectWiFi();

  server.on("/", HTTP_GET, handleRoot);
  server.on("/trigger/hack", HTTP_ANY, handleHack);   // POST from the app, GET for testing
  server.on("/reset", HTTP_ANY, handleReset);
  server.on("/health", HTTP_GET, []() {
    server.send(200, "application/json", statusJson());
  });
  server.onNotFound([]() {
    server.send(404, "application/json", "{\"ok\":false,\"error\":\"not found\"}");
  });
  server.begin();
  Serial.println("[http] listening on :80  ->  POST /trigger/hack");
}

void loop() {
  server.handleClient();

  static uint32_t lastNetCheck = 0;
  if (millis() - lastNetCheck > 10000) {
    lastNetCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[net] link lost, reconnecting");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
  }

  static uint32_t lastFrame = 0;
  if (millis() - lastFrame < 16) return;     // ~60 fps
  lastFrame = millis();

  if (!g_hasPattern) {
    renderIdle();
    return;
  }

  uint32_t elapsed = millis() - g_showStart;
  if (HOLD_MS > 0 && elapsed > (uint32_t)(REVEAL_MS + HOLD_MS)) {
    g_hasPattern = false;
    Serial.println("[hack] hold expired -> idle");
    return;
  }

  uint16_t reveal = ROW_LEN;
  if (REVEAL_MS > 0 && elapsed < REVEAL_MS) {
    reveal = (uint16_t)((uint32_t)ROW_LEN * elapsed / REVEAL_MS);
  }
  renderPattern(reveal);
}
