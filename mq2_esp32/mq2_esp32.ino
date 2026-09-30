/*
 * MQ-2 gas sensor on an ESP32  ->  act4embed dashboard (FastAPI on the Raspberry Pi)
 *
 * WIRING (use an ADC1 pin, GPIO34. ADC2 pins stop working when Wi-Fi is on!)
 *   MQ-2 VCC -> ESP32 VIN (5V, board powered over USB)
 *   MQ-2 GND -> ESP32 GND               (grounds MUST be common)
 *   MQ-2 AO  -> 10k -> [junction] -> GPIO34
 *                       [junction] -> 10k + 10k in series (20k) -> GND
 *   The divider turns the sensor's 0-5 V into 0-3.3 V. The ESP32 pin is NOT 5 V tolerant.
 *   Optional: 100 nF capacitor between GPIO34 and GND for a steadier reading.
 *
 * SERIAL MONITOR: 115200 baud (any line-ending setting works)
 *   type  C  (or c) + Enter : record 30 s of CLEAN AIR, the mean becomes the clean-air baseline
 *   type  X  (or x) + Enter : cancel a running calibration
 *   The ADC value is printed every 1 second.
 *
 * The baseline is stored in flash, so it survives a reboot.
 * Every second the sketch POSTs the reading to the dashboard (SERVER_URL).
 *
 * Board: any "ESP32 Dev Module". Libraries: none to install (all come with the ESP32 core).
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include "esp_timer.h"

// ============================ EDIT THESE ============================
const char* WIFI_SSID  = "HUAWEI-z3UH";                        // 2.4 GHz network only
const char* WIFI_PASS  = "NargatanFMLY";
const char* SERVER_URL = "http://10.120.212.181:5000/api/esp32";    // Pi IP from: hostname -I
const char* API_KEY    = "act4embed";                             // = ESP32_TOKEN in config.py
// ====================================================================

const int      MQ2_PIN            = 34;      // ADC1_CH6, input only
const int      OVERSAMPLE         = 16;      // analogRead() calls averaged per sample
const uint32_t SAMPLE_INTERVAL_MS = 100;     // one sample every 100 ms
const uint32_t PRINT_INTERVAL_MS  = 1000;    // print + send every 1 s
const uint32_t CAL_DURATION_MS    = 30000;   // calibration length: 30 s
const uint32_t WARMUP_HINT_S      = 180;     // warn if calibrating sooner than this after power-up

// ---- values shared with the network task (single 32-bit writes are atomic on ESP32)
volatile int   g_adc         = -1;      // last 1-second average (0-4095), -1 = none yet
volatile bool  g_calibrating = false;
volatile float g_cleanAir    = -1.0f;   // < 0 means "not calibrated"
volatile int   g_httpCode    = 0;       // 0 = no request yet, 200 = OK, < 0 = error

// ---- calibration state (main loop only)
bool     calibrating = false;
uint32_t calStartMs  = 0;
double   calSum      = 0;
uint32_t calCount    = 0;
int      calMin      = 4095;
int      calMax      = 0;

// ---- 1-second window (main loop only)
uint32_t winSum   = 0;
uint32_t winCount = 0;

Preferences prefs;

uint32_t uptimeSeconds() { return (uint32_t)(esp_timer_get_time() / 1000000ULL); }

// Average of OVERSAMPLE raw 12-bit readings (0-4095).
int readAdcAveraged() {
  uint32_t sum = 0;
  for (int i = 0; i < OVERSAMPLE; i++) {
    sum += analogRead(MQ2_PIN);
    delayMicroseconds(100);
  }
  return (int)((sum + OVERSAMPLE / 2) / OVERSAMPLE);
}

// Same idea, but in millivolts at the pin (uses the chip's factory ADC calibration).
uint32_t readMilliVoltsAveraged() {
  uint32_t sum = 0;
  for (int i = 0; i < OVERSAMPLE; i++) {
    sum += analogReadMilliVolts(MQ2_PIN);
    delayMicroseconds(100);
  }
  return (sum + OVERSAMPLE / 2) / OVERSAMPLE;
}

// ------------------------------------------------------------------ calibration
void startCalibration() {
  if (calibrating) {
    Serial.println(">>> Calibration is already running (type X to cancel).");
    return;
  }
  calibrating = true;
  g_calibrating = true;
  calStartMs = millis();
  calSum = 0;
  calCount = 0;
  calMin = 4095;
  calMax = 0;
  Serial.println();
  Serial.println(">>> CALIBRATION STARTED: keep the sensor in CLEAN AIR for 30 seconds (type X to cancel).");
  if (uptimeSeconds() < WARMUP_HINT_S) {
    Serial.printf(">>> Note: the sensor has only been powered for %u s. An MQ-2 needs a few minutes to warm up;\n", (unsigned)uptimeSeconds());
    Serial.println(">>>       calibrating now gives a baseline that is too high. Type X to cancel and try again later.");
  }
}

void cancelCalibration() {
  if (!calibrating) {
    Serial.println(">>> No calibration is running.");
    return;
  }
  calibrating = false;
  g_calibrating = false;
  Serial.println(">>> Calibration cancelled. The previous baseline was kept.");
}

void finishCalibration() {
  calibrating = false;
  g_calibrating = false;
  if (calCount == 0) {
    Serial.println(">>> Calibration failed: no samples were recorded.");
    return;
  }
  float mean = (float)(calSum / (double)calCount);
  g_cleanAir = mean;
  prefs.begin("mq2", false);
  prefs.putFloat("clean", mean);
  prefs.putBool("has", true);
  prefs.end();
  Serial.println();
  Serial.println(">>> CALIBRATION DONE");
  Serial.printf(">>> samples = %u   min = %d   max = %d\n", (unsigned)calCount, calMin, calMax);
  Serial.printf(">>> CLEAN AIR BASELINE (mean ADC) = %.1f  (of 4095, saved to flash)\n", mean);
  if (calMax - calMin > 150) {
    Serial.println(">>> WARNING: the readings moved a lot during calibration. The sensor may still be warming up,");
    Serial.println(">>>          or there was gas / a draught nearby. Type C to calibrate again if this looks wrong.");
  }
  Serial.println();
}

// ------------------------------------------------------------------ serial commands
void handleSerial() {
  while (Serial.available() > 0) {
    char ch = (char)Serial.read();
    if (ch == 'c' || ch == 'C') startCalibration();
    else if (ch == 'x' || ch == 'X') cancelCalibration();
    else if (ch == '\n' || ch == '\r' || ch == ' ' || ch == '\t') { /* ignore */ }
    else Serial.printf("Unknown command '%c'. C = calibrate clean air (30 s), X = cancel.\n", ch);
  }
}

// ------------------------------------------------------------------ network task (core 0)
// Runs separately so a slow or missing server can never delay the 1-second printing or the sampling.
void netTask(void* /*unused*/) {
  bool wasConnected = false;
  uint32_t lastPost = 0;
  uint32_t lastAttempt = millis();

  for (;;) {
    uint32_t now = millis();
    bool connected = (WiFi.status() == WL_CONNECTED);

    if (connected && !wasConnected)
      Serial.printf("[WiFi] connected, ESP32 IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    if (!connected && wasConnected)
      Serial.println("[WiFi] connection lost, reconnecting...");
    wasConnected = connected;

    if (!connected && (uint32_t)(now - lastAttempt) > 20000) {   // still not connected: try again
      lastAttempt = now;
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }

    if (connected && g_adc >= 0 && (uint32_t)(now - lastPost) >= PRINT_INTERVAL_MS) {
      lastPost = now;

      char caStr[16];
      float ca = g_cleanAir;
      if (ca < 0) strcpy(caStr, "null");
      else snprintf(caStr, sizeof(caStr), "%.1f", ca);

      char body[200];
      snprintf(body, sizeof(body),
               "{\"adc\":%d,\"clean_air\":%s,\"calibrating\":%s,\"uptime_s\":%lu,\"rssi\":%d}",
               (int)g_adc, caStr, g_calibrating ? "true" : "false",
               (unsigned long)uptimeSeconds(), (int)WiFi.RSSI());

      WiFiClient client;
      HTTPClient http;
      http.setConnectTimeout(2000);
      http.setTimeout(2000);
      if (http.begin(client, SERVER_URL)) {
        http.addHeader("Content-Type", "application/json");
        http.addHeader("X-API-Key", API_KEY);
        g_httpCode = http.POST((uint8_t*)body, strlen(body));
        http.end();
      } else {
        g_httpCode = -100;   // bad SERVER_URL
      }
    }

    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

// ------------------------------------------------------------------ setup / loop
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("==================================================");
  Serial.println(" MQ-2 on ESP32  ->  act4embed dashboard");
  Serial.println(" Serial monitor: 115200 baud");
  Serial.println(" Type C = calibrate clean air (30 s)   X = cancel");
  Serial.println("==================================================");

  analogReadResolution(12);                        // 0-4095
  analogSetPinAttenuation(MQ2_PIN, ADC_11db);      // full 0-3.3 V range
  pinMode(MQ2_PIN, INPUT);

  prefs.begin("mq2", false);
  if (prefs.getBool("has", false)) {
    g_cleanAir = prefs.getFloat("clean", -1.0f);
    Serial.printf("Saved clean-air baseline loaded: %.1f\n", (float)g_cleanAir);
  } else {
    Serial.println("Not calibrated yet. Warm the sensor up for a few minutes in clean air, then type C.");
  }
  prefs.end();

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("Connecting to Wi-Fi \"%s\" ...\n", WIFI_SSID);

  xTaskCreatePinnedToCore(netTask, "net", 8192, NULL, 1, NULL, 0);
}

void loop() {
  static uint32_t lastSample = 0;
  static uint32_t lastPrint  = 0;

  handleSerial();

  uint32_t now = millis();

  // ---- one sample every 100 ms
  if ((uint32_t)(now - lastSample) >= SAMPLE_INTERVAL_MS) {
    lastSample = now;
    int v = readAdcAveraged();
    winSum += (uint32_t)v;
    winCount++;
    if (calibrating) {
      calSum += v;
      calCount++;
      if (v < calMin) calMin = v;
      if (v > calMax) calMax = v;
    }
  }

  // ---- once per second: publish + print
  if ((uint32_t)(now - lastPrint) >= PRINT_INTERVAL_MS) {
    lastPrint = now;

    int adc = (winCount > 0) ? (int)((winSum + winCount / 2) / winCount) : readAdcAveraged();
    winSum = 0;
    winCount = 0;
    g_adc = adc;

    uint32_t mv = readMilliVoltsAveraged();
    float ca = g_cleanAir;
    int code = g_httpCode;
    bool wifiOk = (WiFi.status() == WL_CONNECTED);

    char caText[24];
    if (ca < 0) strcpy(caText, "not set");
    else snprintf(caText, sizeof(caText), "%.1f", ca);

    char srvText[48];
    if (!wifiOk) strcpy(srvText, "no Wi-Fi");
    else if (code == 0) strcpy(srvText, "waiting");
    else if (code > 0) snprintf(srvText, sizeof(srvText), "HTTP %d%s", code, code == 200 ? " OK" : " (check API_KEY/URL)");
    else snprintf(srvText, sizeof(srvText), "ERR %d %s", code, code == -100 ? "bad SERVER_URL" : HTTPClient::errorToString(code).c_str());

    if (calibrating) {
      uint32_t elapsed = (uint32_t)(now - calStartMs) / 1000;
      if (elapsed > 30) elapsed = 30;
      Serial.printf("[%5u s] CALIBRATING %2u/30 s  MQ2 ADC = %4d / 4095  (pin %u mV)  clean air = %s  server: %s\n",
                    (unsigned)uptimeSeconds(), (unsigned)elapsed, adc, (unsigned)mv, caText, srvText);
      if ((uint32_t)(now - calStartMs) >= CAL_DURATION_MS) finishCalibration();
    } else {
      Serial.printf("[%5u s] MQ2 ADC = %4d / 4095  (pin %u mV)  clean air = %s  wifi: %s  server: %s\n",
                    (unsigned)uptimeSeconds(), adc, (unsigned)mv, caText, wifiOk ? "OK" : "connecting", srvText);
    }
  }

  delay(2);   // let other tasks run
}
