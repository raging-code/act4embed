#!/usr/bin/env node
/**
 * patch-ads1115.mjs  -  act4embed: MQ-2 -> ADS1115 (I2C) -> Raspberry Pi 5
 *
 * Run from the project root:   node patch-ads1115.mjs
 * Idempotent: running it again does nothing. All edits are validated first,
 * nothing is written unless every marker was found.
 *
 * What it does
 *   config.py            MCP3008/ESP32 settings -> ADS1115 settings
 *   app.py               ESP32 input + /api/esp32 removed; ADS1115 reader over I2C (smbus2),
 *                        clean-air calibration done on the Pi (Calibrate button), same 0-1023 scale
 *   templates/index.html source/raw labels, Calibrate button
 *   requirements.txt     + smbus2
 *   README.md            ADS1115 wiring + setup replaces the ESP32 section
 * The mq2_esp32/ folder is left alone (delete it yourself when you no longer need it).
 */
import fs from "node:fs";
import path from "node:path";

console.log("patch-ads1115 v3 (CRLF-safe)");
const ROOT = process.cwd();
const MARK = "ads1115-patch";
const P = (f) => path.join(ROOT, f);

const crlf = new Set();   // files that use CRLF on disk: matched as LF, written back as CRLF
const read = (f) => {
  if (!fs.existsSync(P(f))) die(`File not found: ${f}  (run this from the project root)`);
  const raw = fs.readFileSync(P(f), "utf8");
  if (raw.includes("\r\n")) { crlf.add(f); return raw.replace(/\r\n/g, "\n"); }
  return raw;
};
function die(msg) { console.error("ERROR: " + msg); process.exit(1); }

const lineStart = (src, needle, from = 0) => {
  const i = src.indexOf(needle, from);
  if (i < 0) die(`marker not found: ${needle.slice(0, 70)}`);
  return src.lastIndexOf("\n", i) + 1;
};
function between(src, startNeedle, endNeedle, replacement) {
  const a = lineStart(src, startNeedle);
  const b = endNeedle === null ? src.length : lineStart(src, endNeedle, a + 1);
  return src.slice(0, a) + replacement + src.slice(b);
}
function swap(src, oldStr, newStr) {
  const i = src.indexOf(oldStr);
  if (i < 0) die(`text not found: ${oldStr.slice(0, 70)}`);
  if (src.indexOf(oldStr, i + 1) >= 0) die(`text not unique: ${oldStr.slice(0, 70)}`);
  return src.slice(0, i) + newStr + src.slice(i + oldStr.length);
}

const out = {};   // file -> new content (written at the very end)

// ======================================================================= config.py
{
  let s = read("config.py");
  if (s.includes(MARK)) { console.log("config.py: already patched"); }
  else {
    s = between(s, "# ---------------- MQ-2 gas sensor via MCP3008", "# ---------------- Alarm logic", String.raw`# ---------------- MQ-2 gas sensor via ADS1115 ADC (I2C)  (ads1115-patch) ----------------
# ADS1115: VDD->3.3V, GND->GND, SCL->GPIO3 (pin 5), SDA->GPIO2 (pin 3), ADDR->GND (address 0x48),
# A0 -> MQ-2 AO through the 10k/20k divider. Enable I2C: sudo raspi-config -> Interface Options -> I2C.
ADS_I2C_BUS = 1               # /dev/i2c-1 (the Pi header pins 3 and 5)
ADS_ADDRESS = 0x48            # ADDR->GND 0x48, ->VDD 0x49, ->SDA 0x4A, ->SCL 0x4B
ADS_CHANNEL = 0               # MQ-2 is on A0 (0-3)
ADS_OVERSAMPLE = 8            # conversions averaged per reading (128 SPS, about 70 ms in total)
# The ADS1115 runs at +-4.096 V (0.125 mV per count). The dashboard keeps its old 0-1023 scale:
# 0 mV at the ADS1115 pin = 0, ADC_FULLSCALE_MV at the pin = 1023.
ADC_FULLSCALE_MV = 3300
# MQ-2 AO can reach 5 V but the ADS1115 is powered from 3.3 V (its inputs must stay below VDD + 0.3 V).
# The wiring guide uses a voltage divider (10k top + 20k bottom) -> the ADS1115 sees 2/3 of the sensor voltage.
# If you do NOT use a divider (not recommended) set this to 1.0.
ADC_DIVIDER_RATIO = 1.5

`);
    s = between(s, "# ---------------- ESP32 (the MQ-2", null, String.raw`# ---------------- Clean-air calibration (done on the Pi, "Calibrate" button on the Live page) ----------------
CAL_SECONDS = 30              # how long the clean-air average is recorded
`);
    out["config.py"] = s;
  }
}

// ======================================================================= app.py
const APP_ADS_SECTION = String.raw`# ----------------------------------------------------------------- ads1115 input  (ads1115-patch)
# The MQ-2 analog output goes through a 10k/20k divider to A0 of an ADS1115 (16-bit I2C ADC) on the Pi.
try:
    from smbus2 import SMBus
except Exception:
    SMBus = None

CAL_PATH = os.path.join(DATA_DIR, "calibration.json")
gas_lock = threading.Lock()
gas_info = {"raw": None, "mv": None, "ts": 0.0}
cal = {"clean_mv": None, "active": False, "start": 0.0, "sum": 0.0, "n": 0}
GAS_FRESH_SECONDS = 5


def load_calibration():
    try:
        with open(CAL_PATH) as f:
            v = float(json.load(f).get("clean_mv"))
        if 0 <= v <= 6000:
            cal["clean_mv"] = v
    except Exception:
        pass


def _save_calibration():
    try:
        with open(CAL_PATH, "w") as f:
            json.dump({"clean_mv": cal["clean_mv"]}, f)
    except OSError as e:
        print("Could not save calibration:", e)


load_calibration()


def mv_to_counts(mv):
    """Millivolts at the ADS1115 pin -> the dashboard's 0-1023 scale."""
    return int(round(max(0, min(1023, mv * 1023 / config.ADC_FULLSCALE_MV))))


def calibration_start():
    with gas_lock:
        cal.update(active=True, start=time.time(), sum=0.0, n=0)


def calibration_cancel():
    with gas_lock:
        cal["active"] = False


def _cal_feed(mv, now):
    """Called with every gas reading: while calibrating, collect them; after CAL_SECONDS store the mean."""
    with gas_lock:
        if not cal["active"]:
            return
        cal["sum"] += mv
        cal["n"] += 1
        if now - cal["start"] < config.CAL_SECONDS:
            return
        cal["active"] = False
        if cal["n"]:
            cal["clean_mv"] = cal["sum"] / cal["n"]
            _save_calibration()


class ADS1115:
    """Minimal single-shot ADS1115 driver (smbus2). +-4.096 V range, 128 SPS, single-ended AINx vs GND."""
    LSB_MV = 4096.0 / 32768.0       # 0.125 mV per count

    def __init__(self, bus, address, channel):
        if SMBus is None:
            raise RuntimeError("smbus2 is not installed (pip install smbus2)")
        if channel not in (0, 1, 2, 3):
            raise ValueError("ADS_CHANNEL must be 0-3")
        self.address, self.io = address, threading.Lock()
        # OS=1 start | MUX=100+ch | PGA=001 (+-4.096 V) | MODE=1 single-shot | DR=100 (128 SPS) | comparator off
        self.cfg = 0x8000 | ((0x4 + channel) << 12) | (0x1 << 9) | 0x0100 | (0x4 << 5) | 0x0003
        self.bus = SMBus(bus)
        self.read_raw()             # fail now (and show it on the dashboard) if the chip does not answer

    def _one(self):
        self.bus.write_i2c_block_data(self.address, 0x01, [self.cfg >> 8, self.cfg & 0xFF])
        deadline = time.time() + 0.25
        while True:
            time.sleep(0.009)       # one conversion takes 7.8 ms
            hi, _lo = self.bus.read_i2c_block_data(self.address, 0x01, 2)
            if hi & 0x80:           # OS bit = conversion finished
                break
            if time.time() > deadline:
                raise RuntimeError("ADS1115 conversion timeout")
        hi, lo = self.bus.read_i2c_block_data(self.address, 0x00, 2)
        v = (hi << 8) | lo
        return v - 65536 if v & 0x8000 else v

    def read_raw(self, n=1):
        with self.io:
            vals = [self._one() for _ in range(max(1, n))]
        return sum(vals) / len(vals)

    def close(self):
        try:
            self.bus.close()
        except Exception:
            pass


def warmup_left(now):
    """Seconds of MQ-2 warm-up left (the heater starts when the Pi powers it, so this follows app start)."""
    return max(0.0, config.WARMUP_SECONDS - (now - START_TIME))


def gas_snapshot():
    """Extra fields for /data (the Live page shows them)."""
    now = time.time()
    with gas_lock:
        g, clean, active, start = dict(gas_info), cal["clean_mv"], cal["active"], cal["start"]
    fresh = g["raw"] is not None and (now - g["ts"]) <= GAS_FRESH_SECONDS
    return {
        "gas_source": "ads1115" if (fresh and not SIMULATION) else ("simulated" if (fresh and SIMULATION) else "none"),
        "gas_raw": g["raw"] if fresh else None,
        "gas_mv": g["mv"] if fresh else None,
        "clean_air_mv": None if clean is None else round(clean, 1),
        "clean_air": None if clean is None else mv_to_counts(clean),
        "calibrating": bool(active),
        "cal_left": max(0, int(math.ceil(config.CAL_SECONDS - (now - start)))) if active else 0,
    }


`;

const APP_READ_GAS = String.raw`    def read_gas(self):
        """Return the MQ-2 value as 0-1023 (ADS1115 millivolts at the pin, rescaled)."""
        now = time.time()
        if SIMULATION:                  # no hardware: fake data so the site can be tested on a PC
            v = 180 + 25 * math.sin(now / 7) + random.uniform(-8, 8)
            if now < self.sim_gas_until:
                v += 450                # "Simulate gas leak" test button
            v = max(0.0, min(1023.0, v))
            mv = v * config.ADC_FULLSCALE_MV / 1023
            with gas_lock:
                gas_info.update(raw=int(round(mv / ADS1115.LSB_MV)), mv=round(mv, 1), ts=now)
            _cal_feed(mv, now)
            return int(round(v))
        if self.gas is None:
            raise RuntimeError(self.errors.get("gas", "ADS1115 not initialised") +
                               " (check I2C is enabled, wiring and 'sudo i2cdetect -y 1' shows 48)")
        raw = self.gas.read_raw(config.ADS_OVERSAMPLE)
        mv = max(0.0, raw * ADS1115.LSB_MV)
        if mv > config.ADC_FULLSCALE_MV + 300:
            raise RuntimeError(f"{mv:.0f} mV on A{config.ADS_CHANNEL} is too high: check the 10k/20k divider "
                               "and that the ADS1115 is powered from 3.3 V")
        with gas_lock:
            gas_info.update(raw=int(round(raw)), mv=round(mv, 1), ts=now)
        _cal_feed(mv, now)
        return mv_to_counts(mv)

`;

const APP_CONTROL_CAL = String.raw`    elif action == "calibrate":
        calibration_start()
    elif action == "calibrate_cancel":
        calibration_cancel()
`;

{
  let s = read("app.py");
  if (s.includes(MARK)) { console.log("app.py: already patched"); }
  else {
    s = swap(s, "(MQ-2 read by an ESP32)", "(MQ-2 read through an ADS1115)");
    s = between(s, "esp32 input", "----- hardware", APP_ADS_SECTION);
    s = swap(s, "        # gas: read by the ESP32 (see esp32 input section), no ADC on the Pi",
      '        self._init("gas", lambda: ADS1115(config.ADS_I2C_BUS, config.ADS_ADDRESS, config.ADS_CHANNEL))');
    s = between(s, "    def read_gas(self):", "    def read_vib(self):", APP_READ_GAS);
    s = swap(s, "    out.update(esp32_snapshot())", "    out.update(gas_snapshot())");
    s = between(s, '@app.post("/api/esp32")', '@app.post("/control")', "");
    s = swap(s, '    elif action == "sim_gas" and SIMULATION:', APP_CONTROL_CAL + '    elif action == "sim_gas" and SIMULATION:');
    s = swap(s, 'print("Gas sensor: MQ-2 on the ESP32 -> POST http://<this-ip>:%d/api/esp32" % config.PORT)',
      'print("Gas sensor: MQ-2 -> ADS1115 (I2C bus %d, address 0x%02X, A%d)" % (config.ADS_I2C_BUS, config.ADS_ADDRESS, config.ADS_CHANNEL))');
    s = swap(s, "its own copy of the ESP32 readings", "its own copy of the sensor readings");
    out["app.py"] = s;
  }
}

// ======================================================================= templates/index.html
{
  let s = read("templates/index.html");
  if (s.includes(MARK)) { console.log("templates/index.html: already patched"); }
  else {
    s = swap(s, "from the ESP32 when it is connected, otherwise it is fake", "from the ADS1115 when it is connected, otherwise it is fake");
    s = swap(s, 'raw ADC <span id="gasRaw">--</span> of 4095</p>',
      'raw ADS1115 <span id="gasRaw">--</span> of 32767 (<span id="gasMv">--</span> mV at the pin)</p>');
    s = swap(s, '<p class="muted">Clean air baseline: <span id="cleanAir">--</span></p>',
      '<p class="muted">Clean air baseline: <span id="cleanAir">--</span> ' +
      '<button class="btn" id="calBtn" type="button" onclick="control(window.__cal ? \'calibrate_cancel\' : \'calibrate\')">Calibrate</button></p><!-- ' + MARK + ' -->');
    // JS: source / raw / baseline lines
    const a = lineStart(s, "setText('gasSrc'");
    const bIdx = s.indexOf("setText('cleanAir'", a);
    if (bIdx < 0) die("cleanAir JS line not found");
    const bEnd = s.indexOf("\n", s.indexOf("\n", bIdx) + 1) + 1;     // cleanAir statement spans 2 lines
    s = s.slice(0, a) + [
      "  setText('gasSrc', d.gas_source === 'ads1115' ? 'ADS1115 (A0)' : d.gas_source === 'simulated' ? 'simulated' : 'no ADS1115 data');",
      "  setText('gasRaw', d.gas_raw == null ? '--' : d.gas_raw);",
      "  setText('gasMv', d.gas_mv == null ? '--' : d.gas_mv);",
      "  setText('cleanAir', d.calibrating ? 'calibrating, ' + d.cal_left + ' s left, keep the sensor in clean air...'",
      "    : d.clean_air == null ? 'not calibrated (press Calibrate while the sensor is in clean air)' : d.clean_air + ' of 1023 (' + d.clean_air_mv + ' mV)');",
      "  window.__cal = !!d.calibrating;",
      "  { const cb = $('calBtn'); if (cb) cb.textContent = d.calibrating ? 'Cancel' : 'Calibrate'; }",
      "",
    ].join("\n") + s.slice(bEnd);
    out["templates/index.html"] = s;
  }
}

// ======================================================================= requirements.txt
{
  let s = read("requirements.txt");
  if (s.includes("smbus2")) { console.log("requirements.txt: already patched"); }
  else {
    out["requirements.txt"] = [
      "fastapi>=0.110", "uvicorn>=0.29", "jinja2>=3.1", "smbus2>=0.4",
      "# gpiozero and lgpio come from apt on Raspberry Pi OS (see README.md)", "",
    ].join("\n");
  }
}

// ======================================================================= README.md
{
  let s = read("README.md");
  if (s.includes(MARK)) { console.log("README.md: already patched"); }
  else {
    s = s.replace("MQ-2 gas sensor (through an MCP3008 ADC)", "MQ-2 gas sensor (through an ADS1115 ADC)");
    s = between(s, "## ESP32 + FastAPI", null, String.raw`## ADS1115 + FastAPI (replaces the MCP3008 and the ESP32)  <!-- ads1115-patch -->
The server is FastAPI (uvicorn); ` + "`python app.py`" + String.raw` starts it. The MQ-2 is read by an **ADS1115** (16-bit I2C ADC) that sits
directly on the Pi: MQ-2 -> ADS1115 -> Raspberry Pi 5. Sections 1 and the MCP3008 rows of section 4 above no longer apply
(SPI is not needed). The ESP32 sketch (mq2_esp32/) and the /api/esp32 endpoint are no longer used.

    sudo raspi-config                 ->  Interface Options  ->  I2C  ->  Yes   (then reboot)
    sudo apt install -y i2c-tools
    sudo i2cdetect -y 1               ->  should show  48
    pip install -r requirements.txt   # fastapi, uvicorn, jinja2, smbus2
    python app.py

ADS1115 wiring (the module is powered from **3.3 V** so the I2C lines are 3.3 V; the Pi pins are not 5 V tolerant):
| ADS1115 pin | Connect to |
|---|---|
| VDD | Pi 3.3V (pin 1) |
| GND | Pi GND (pin 6) |
| SCL | GPIO3 / SCL (pin 5) |
| SDA | GPIO2 / SDA (pin 3) |
| ADDR | GND (I2C address 0x48) |
| A0 | MQ-2 AO **through the divider below** |
| ALRT | not connected |

MQ-2 module: VCC -> Pi 5V (pin 2), GND -> Pi GND (common with the ADS1115).
AO -> 10k resistor -> junction (goes to ADS1115 A0) -> two 10k resistors in series (20k) -> GND.
Keep the divider: the MQ-2 outputs up to 5 V, and the ADS1115 input must not exceed VDD + 0.3 V (3.6 V).
The Pi software maps 0-3.3 V at A0 to the dashboard's 0-1023 scale, so the alarm threshold keeps its old meaning.

Clean-air baseline: warm the MQ-2 up for a few minutes in clean air, then press **Calibrate** on the Live page
(30 s, saved to data/calibration.json). Settings: ADS_* in config.py.

| Symptom | Fix |
|---|---|
| ` + "`i2cdetect`" + String.raw` shows no 48 | I2C not enabled, SDA/SCL swapped, no 3.3 V, or ADDR not on GND |
| "Gas sensor error ... smbus2" | ` + "`pip install smbus2`" + String.raw` (in the same venv) |
| "... mV on A0 is too high" | Divider missing/wrong, or ADS1115 not powered from 3.3 V |
| Gas value stuck at 0 | A0 wire or MQ-2 power; check ADS_CHANNEL |
`);
    out["README.md"] = s;
  }
}

// ======================================================================= write
const files = Object.keys(out);
if (!files.length) { console.log("Nothing to do (already patched)."); process.exit(0); }
for (const f of files) fs.writeFileSync(P(f), crlf.has(f) ? out[f].replace(/\n/g, "\r\n") : out[f]);
console.log("Patched: " + files.join(", "));
console.log("Next: pip install -r requirements.txt  &&  wire the ADS1115 (see README.md)  &&  python app.py");
