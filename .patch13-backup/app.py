"""
Gas & Vibration Monitoring Dashboard - Raspberry Pi 5 + FastAPI (MQ-2 read by an ESP32)
Run:  python app.py      then open  http://<pi-ip>:5000
"""
import atexit
import csv
import io
import json
import math
import os
import random
import smtplib
import socket
import sqlite3
import threading
import time
import traceback
from collections import deque
from contextlib import closing
from datetime import datetime
from email.message import EmailMessage

import hmac
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

import config

# gpiozero works on the Pi 5 (RPi.GPIO does NOT). It uses the lgpio backend.
try:
    from gpiozero import LED, Buzzer, DigitalInputDevice
    GPIO_AVAILABLE = True
except Exception:
    GPIO_AVAILABLE = False


def on_raspberry_pi():
    try:
        with open("/proc/device-tree/model") as f:
            return "Raspberry Pi" in f.read()
    except OSError:
        return False


SIMULATION = config.SIMULATE or not (GPIO_AVAILABLE and on_raspberry_pi())

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "sensor.db")
SETTINGS_PATH = os.path.join(DATA_DIR, "settings.json")
START_TIME = time.time()

lock = threading.Lock()


# ----------------------------------------------------------------- settings
def load_settings():
    s = {"threshold": config.DEFAULT_GAS_THRESHOLD, "armed": True}
    try:
        with open(SETTINGS_PATH) as f:
            d = json.load(f)
    except Exception:
        return s
    if isinstance(d, dict):
        try:
            t = int(d.get("threshold"))
            if 1 <= t <= 1023:
                s["threshold"] = t
        except (TypeError, ValueError):
            pass
        s["armed"] = bool(d.get("armed", True))
    return s


def save_settings():
    try:
        with open(SETTINGS_PATH, "w") as f:
            json.dump(settings, f)
    except OSError as e:
        print("Could not save settings:", e)


settings = load_settings()

# ambient-settings: email settings that can be edited from the Settings page
import re as _re

EMAIL_PATH = os.path.join(DATA_DIR, "email.json")
PLACEHOLDER_EMAILS = ("your_email@gmail.com", "receiver@example.com")
email_file = {}     # only what the user saved from the web page


def apply_email():
    """Copy the saved email settings onto the config module the rest of app.py reads."""
    if "enabled" in email_file:
        config.EMAIL_ENABLED = bool(email_file["enabled"])
    for key, attr in (("user", "SMTP_USER"), ("password", "SMTP_PASSWORD"),
                      ("to", "EMAIL_TO"), ("host", "SMTP_HOST")):
        if email_file.get(key):
            setattr(config, attr, str(email_file[key]))
    if email_file.get("port"):
        config.SMTP_PORT = int(email_file["port"])


def load_email_settings():
    try:
        with open(EMAIL_PATH) as f:
            email_file.update(json.load(f))
        apply_email()
    except (OSError, ValueError, TypeError):
        pass


def save_email_settings():
    try:
        with open(EMAIL_PATH, "w") as f:
            json.dump(email_file, f)
        os.chmod(EMAIL_PATH, 0o600)      # the app password is stored here
    except OSError as e:
        print("Could not save email settings:", e)


load_email_settings()


# ----------------------------------------------------------------- database
def db_exec(sql, args=()):
    with closing(sqlite3.connect(DB_PATH, timeout=10)) as c:
        cur = c.execute(sql, args)
        c.commit()
        return cur.lastrowid


def db_query(sql, args=()):
    with closing(sqlite3.connect(DB_PATH, timeout=10)) as c:
        c.row_factory = sqlite3.Row
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def init_db():
    with closing(sqlite3.connect(DB_PATH, timeout=10)) as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS readings(
                ts INTEGER NOT NULL, gas INTEGER, vib INTEGER, status TEXT);
            CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);
            CREATE TABLE IF NOT EXISTS alerts(
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
                kind TEXT, message TEXT, email_sent INTEGER DEFAULT 0);
            CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
            """
        )
        cutoff = int(time.time() - config.RETENTION_DAYS * 86400)
        c.execute("DELETE FROM readings WHERE ts < ?", (cutoff,))
        c.execute("DELETE FROM alerts WHERE ts < ?", (cutoff,))
        c.commit()


# ----------------------------------------------------------------- esp32 input
# fastapi-esp32: the MQ-2 is wired to an ESP32 (12-bit ADC). The ESP32 POSTs its reading to
# /api/esp32 every second; the sensor loop below reads the newest value from here.
esp_lock = threading.Lock()
esp32 = {"adc": None, "ts": 0.0, "clean_air": None, "calibrating": False,
         "boot_ts": None, "ip": None, "rssi": None}


def esp32_fresh(now=None):
    """True if the ESP32 sent a reading within the last ESP32_TIMEOUT seconds."""
    now = time.time() if now is None else now
    with esp_lock:
        return esp32["adc"] is not None and (now - esp32["ts"]) <= config.ESP32_TIMEOUT


def warmup_left(now):
    """Seconds of MQ-2 warm-up left. The heater starts when the ESP32 powers up, so
    this follows the ESP32 uptime. Before the first packet it uses the app start."""
    with esp_lock:
        boot = esp32["boot_ts"]
    ref = boot if boot is not None else START_TIME
    return max(0.0, config.WARMUP_SECONDS - (now - ref))


def esp32_snapshot():
    """Extra fields for /data (the Live page shows them)."""
    now = time.time()
    with esp_lock:
        e = dict(esp32)
    fresh = e["adc"] is not None and (now - e["ts"]) <= config.ESP32_TIMEOUT
    ca = e["clean_air"]
    return {
        "gas_source": "esp32" if fresh else ("simulated" if SIMULATION else "none"),
        "gas_raw": e["adc"] if fresh else None,
        "clean_air_raw": None if ca is None else round(ca, 1),
        "clean_air": None if ca is None else int(round(ca * 1023 / config.ESP32_ADC_MAX)),
        "esp32_calibrating": bool(e["calibrating"]) if fresh else False,
        "esp32_ip": e["ip"],
        "esp32_age": round(now - e["ts"], 1) if e["ts"] else None,
        "esp32_rssi": e["rssi"],
    }


# ----------------------------------------------------------------- hardware
class Hardware:
    """Wraps real GPIO devices, or fakes them in simulation mode.
    A device that fails to start is recorded in self.errors and the web app
    keeps running (the dashboard shows the error)."""

    def __init__(self):
        self.errors = {}
        self.gas = self.vib = self.led = self.buzzer = None
        self.vib_event = 0.0        # time of the latest vibration pulse
        self.sim_gas_until = 0.0
        if SIMULATION:
            return
        # gas: read by the ESP32 (see esp32 input section), no ADC on the Pi
        self._init("vib", lambda: DigitalInputDevice(
            config.VIB_PIN, pull_up=not config.VIB_ACTIVE_HIGH))
        self._init("led", lambda: LED(config.LED_PIN))
        self._init("buzzer", lambda: Buzzer(config.BUZZER_PIN))
        if self.vib is not None:
            # Catches very short pulses that polling could miss.
            self.vib.when_activated = lambda: setattr(self, "vib_event", time.time())

    def _init(self, name, factory):
        try:
            setattr(self, name, factory())
        except Exception as e:
            self.errors[name] = f"{type(e).__name__}: {e}"
            print(f"[hardware] {name} failed to initialise: {self.errors[name]}")

    def read_gas(self):
        """Return the MQ-2 value as 0-1023, rescaled from the ESP32's 12-bit reading
        (the ESP32 already averages many samples per second)."""
        now = time.time()
        with esp_lock:
            raw, ts = esp32["adc"], esp32["ts"]
        if raw is not None and (now - ts) <= config.ESP32_TIMEOUT:
            v = raw * 1023 / config.ESP32_ADC_MAX
            if SIMULATION and now < self.sim_gas_until:
                v += 450                # "Simulate gas leak" test button
            return int(round(max(0, min(1023, v))))
        if SIMULATION:                  # no ESP32 yet: fake data so the site can be tested
            v = 180 + 25 * math.sin(now / 7) + random.uniform(-8, 8)
            if now < self.sim_gas_until:
                v += 450
            return int(max(0, min(1023, v)))
        if raw is None:
            raise RuntimeError("No data from the ESP32 yet (is it powered, on the same Wi-Fi, "
                               "and is SERVER_URL in the sketch this computer's IP?)")
        raise RuntimeError(f"ESP32 silent for {int(now - ts)} s (check its power and Wi-Fi)")

    def read_vib(self):
        if SIMULATION:
            return False            # simulated pulses arrive through vib_event
        if self.vib is None:
            raise RuntimeError(self.errors.get("vib", "not initialised"))
        return bool(self.vib.is_active)

    def set_output(self, name, on):
        dev = getattr(self, name)
        if dev is None:
            return
        dev.on() if on else dev.off()

    def close(self):
        for d in (self.led, self.buzzer):
            try:
                if d is not None:
                    d.off()
            except Exception:
                pass
        for d in (self.gas, self.vib, self.led, self.buzzer):
            try:
                if d is not None:
                    d.close()
            except Exception:
                pass


hw = Hardware()
atexit.register(hw.close)

# ----------------------------------------------------------------- state
ctrl = {"buzzer": "auto", "led": "auto", "muted": False,
        "gas_latch": False,   # gas alarm is latched until "Reset alarm"
        "gas_ack": False,     # alarm was reset while gas was high: wait until the level has dropped once
        "vib_ack": 0.0,       # vibration up to this moment is ignored (Reset alarm, timeout, or while disarmed)
        "vib_start": 0.0,     # when the running vibration alarm started (0 = no vibration alarm)
        "reset_gen": 0,       # +1 on every "Reset alarm": lets the sensor loop see a reset that happened mid-pass
        "vib_wait": False,    # after Reset / 1-min timeout: vibration is ignored until the sensor has been quiet for a while
        "gas_ok_since": None, # since when the gas has been well below the threshold (used to re-arm after Reset)
        "warn_ack": False}    # after Reset: no amber "gas is rising" theme until the gas has really dropped once
series = deque(maxlen=config.GRAPH_POINTS)
state = {
    "gas": None, "gas_voltage": None, "vibration": False, "status": "warmup",
    "reasons": [], "threshold": settings["threshold"],
    "warmup_left": config.WARMUP_SECONDS, "buzzer_on": False, "led_on": False,
    "buzzer_mode": "auto", "led_mode": "auto", "muted": False, "errors": [],
    "last_alert": None, "last_email": None,
    "armed": settings["armed"], "last_vib": None,
    "email_status": "Email alerts are off" if not config.EMAIL_ENABLED else "No email sent yet",
    "email_enabled": config.EMAIL_ENABLED, "simulation": SIMULATION,
    "uptime": 0, "ts": time.time(),
}
last_email_ts = 0.0


# ----------------------------------------------------------------- email
def send_email(subject, body, alert_id=None):
    try:
        if not config.SMTP_PASSWORD:
            raise RuntimeError("SMTP_PASSWORD is empty (set it as an environment variable)")
        msg = EmailMessage()
        msg["Subject"], msg["From"], msg["To"] = subject, config.SMTP_USER, config.EMAIL_TO
        msg.set_content(body)
        if config.SMTP_PORT == 465:
            server = smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, timeout=20)
        else:
            server = smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=20)
            server.starttls()
        with server:
            server.login(config.SMTP_USER, config.SMTP_PASSWORD)
            server.send_message(msg)
        with lock:
            state["last_email"] = time.time()
            state["email_status"] = "Last email sent OK"
        if alert_id:
            db_exec("UPDATE alerts SET email_sent=1 WHERE id=?", (alert_id,))
    except Exception as e:
        print("[email] failed:", e)
        with lock:
            state["email_status"] = f"Email failed: {e}"


def maybe_email(kind, message, alert_id, now):
    global last_email_ts
    if not config.EMAIL_ENABLED:
        return
    if now - last_email_ts < config.EMAIL_COOLDOWN:
        with lock:
            state["email_status"] = "Email skipped (cooldown active)"
        return
    last_email_ts = now
    body = (f"Gas & Vibration Monitor alert\n\nTime: {datetime.now():%Y-%m-%d %H:%M:%S}\n"
            f"Type: {kind}\nDetails: {message}\n")
    threading.Thread(target=send_email, args=(f"ALERT: {kind} detected", body, alert_id),
                     daemon=True).start()


# ----------------------------------------------------------------- sensor loop
def sensor_loop():
    gas_fail, last_good, gas_err = 0, None, ""
    last_vib, prev_active, last_log, last_alert_ts = 0.0, set(), 0.0, 0.0
    while True:
        try:
            now = time.time()
            errors = []

            # ---- gas
            try:
                g = hw.read_gas()
                if not 0 <= g <= 1023:
                    raise ValueError(f"out-of-range ADC value {g}")
                last_good, gas_fail = g, 0
            except Exception as e:
                gas_fail += 1
                gas_err = f"Gas sensor error: {e}"
            gas = last_good if gas_fail < 3 else None
            if gas_fail >= 3:
                errors.append(gas_err)

            # ---- vibration
            try:
                if hw.read_vib():
                    last_vib = now
            except Exception as e:
                errors.append(f"Vibration sensor error: {e}")
            last_vib = max(last_vib, hw.vib_event)
            vibration = (now - last_vib) < config.VIB_HOLD_SECONDS

            for n in ("led", "buzzer"):
                if n in hw.errors:
                    errors.append(f"{n.upper()} error: {hw.errors[n]}")

            # ---- decide alarm + outputs
            with lock:
                my_gen = ctrl["reset_gen"]
                thr = settings["threshold"]
                warm = 0 if (SIMULATION and ctrl.get("sim_skip_warmup")) else warmup_left(now)
                armed = settings["armed"]
                gas_hit = armed and gas is not None and warm == 0 and gas > thr
                if not armed:
                    ctrl["gas_latch"] = ctrl["gas_ack"] = False
                if gas is not None:
                    # re-arm after Reset only when the gas is clearly below the threshold and STAYS there
                    # (a noisy sensor hovering around the threshold must not bring the pop-up back)
                    if gas <= thr * getattr(config, "GAS_REARM_RATIO", 0.9):
                        if ctrl["gas_ok_since"] is None:
                            ctrl["gas_ok_since"] = now
                        if now - ctrl["gas_ok_since"] >= getattr(config, "GAS_REARM_SECONDS", 5):
                            ctrl["gas_ack"] = False     # level is normal again: the next rise alarms again
                    else:
                        ctrl["gas_ok_since"] = None
                if gas_hit and not ctrl["gas_ack"]:
                    ctrl["gas_latch"] = True        # latched: stays on until "Reset alarm" is pressed
                gas_alarm = bool(armed and ctrl["gas_latch"])
                if gas is not None and gas <= thr * 0.7:
                    ctrl["warn_ack"] = False        # gas is really low again: warnings work normally again
                gas_warn = armed and gas is not None and warm == 0 and gas > thr * 0.7 and not ctrl["warn_ack"]
                # vibration: the alarm starts on the first vibration and ends on "Reset alarm" or
                # VIB_ALARM_HOLD seconds after it STARTED (more vibration does not extend it).
                # Disarmed: measured, never alarms, and old vibration is thrown away.
                hold = config.VIB_ALARM_HOLD
                settle = getattr(config, "VIB_SETTLE_SECONDS", 2.0)
                if not armed:
                    ctrl["vib_start"] = 0.0
                    ctrl["vib_ack"] = now
                    ctrl["vib_wait"] = True
                if ctrl["vib_start"] and now - ctrl["vib_start"] >= hold:
                    ctrl["vib_start"] = 0.0         # 1 minute is up
                    ctrl["vib_ack"] = now
                    ctrl["vib_wait"] = True         # a sensor that is STILL vibrating must not restart the alarm at once
                if ctrl["vib_wait"]:
                    ctrl["vib_ack"] = max(ctrl["vib_ack"], last_vib)   # vibration seen while waiting is thrown away
                    if now - last_vib >= settle:
                        ctrl["vib_wait"] = False    # quiet long enough: only NEW vibration may alarm now
                if armed and not ctrl["vib_wait"] and not ctrl["vib_start"] and last_vib > ctrl["vib_ack"]:
                    ctrl["vib_start"] = now
                vib_alarm = bool(armed and ctrl["vib_start"])
                vib_left = max(0, int(math.ceil(hold - (now - ctrl["vib_start"])))) if vib_alarm else 0
                alarm = gas_alarm or vib_alarm
                if not alarm:
                    ctrl["muted"] = False       # mute lasts until the alarm ends
                reasons = []
                if gas_alarm:
                    reasons.append(f"Gas level {gas} is above the threshold {thr}"
                                   if gas is not None and gas > thr else "Gas alarm stays on until it is reset")
                if vib_alarm:
                    reasons.append("Vibration detected")
                bz, ld = ctrl["buzzer"], ctrl["led"]
                buzzer_on = (bz == "on") or (bz == "auto" and alarm and not ctrl["muted"])
                led_on = (ld == "on") or (ld == "auto" and vib_alarm)
                muted, bz_mode, led_mode = ctrl["muted"], bz, ld

            with lock:
                stale = ctrl["reset_gen"] != my_gen
                if not stale:
                    for name, on in (("buzzer", buzzer_on), ("led", led_on)):
                        try:
                            hw.set_output(name, on)
                        except Exception as e:
                            errors.append(f"{name.upper()} error: {e}")
            if stale:
                continue                            # "Reset alarm" was pressed during this pass: redo it now

            if alarm:
                status = "danger"
            elif errors:
                status = "error"
            elif not armed:
                status = "disarmed"
            elif warm > 0:
                status = "warmup"
            elif gas_warn:
                status = "warning"
            else:
                status = "safe"

            with lock:
                if ctrl["reset_gen"] != my_gen:
                    continue                        # reset landed after the outputs: redo the pass
                state.update(
                    gas=gas,
                    gas_voltage=None if gas is None else round(
                        gas / 1023 * 3.3 * config.ADC_DIVIDER_RATIO, 2),
                    vibration=vibration, status=status, reasons=reasons,
                    threshold=thr, warmup_left=int(math.ceil(warm)),
                    buzzer_on=buzzer_on, led_on=led_on, buzzer_mode=bz_mode,
                    led_mode=led_mode, muted=muted, errors=errors,
                    uptime=int(now - START_TIME), ts=now, armed=armed,
                    last_vib=round(last_vib, 1) if last_vib else None,
                    gas_alarm=gas_alarm, vib_alarm=vib_alarm, vib_left=vib_left)
                series.append({"t": round(now, 1), "gas": gas, "vib": int(vibration)})

            # ---- alert when an alarm starts, or a 2nd alarm type joins in
            active = {k for k, on in (("Gas", gas_alarm), ("Vibration", vib_alarm)) if on}
            if (active - prev_active) and now - last_alert_ts >= config.ALERT_MIN_GAP:
                last_alert_ts = now
                kind = " + ".join(sorted(active))
                msg = "; ".join(reasons)
                alert_id = db_exec(
                    "INSERT INTO alerts(ts, kind, message) VALUES(?,?,?)",
                    (int(now), kind, msg))
                with lock:
                    state["last_alert"] = {"ts": now, "kind": kind, "message": msg}
                maybe_email(kind, msg, alert_id, now)
                prev_active = active
            elif not (active - prev_active):
                prev_active = active

            # ---- log to database
            if gas is not None and now - last_log >= config.LOG_INTERVAL:
                last_log = now
                db_exec("INSERT INTO readings(ts, gas, vib, status) VALUES(?,?,?,?)",
                        (int(now), gas, int(vibration), status))
        except Exception:
            traceback.print_exc()
            time.sleep(1)
        time.sleep(config.SAMPLE_INTERVAL)


# ----------------------------------------------------------------- web app (FastAPI)
@asynccontextmanager
async def lifespan(_app):
    init_db()
    threading.Thread(target=sensor_loop, daemon=True).start()
    yield


app = FastAPI(title="Gas & Vibration Monitor", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))


async def get_json(request):
    """Body as a dict, or {} if it is missing or not a JSON object."""
    try:
        d = await request.json()
    except Exception:
        return {}
    return d if isinstance(d, dict) else {}


def bad(message, code=400):
    return JSONResponse({"ok": False, "error": message}, status_code=code)


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def index(request: Request):
    return templates.TemplateResponse(
        request, "index.html", {"sim": SIMULATION, "warmup_total": config.WARMUP_SECONDS})


@app.get("/history", response_class=HTMLResponse, include_in_schema=False)
def history_page(request: Request):
    return templates.TemplateResponse(request, "history.html", {"sim": SIMULATION})


@app.get("/settings", response_class=HTMLResponse, include_in_schema=False)
def settings_page(request: Request):
    return templates.TemplateResponse(request, "settings.html", {"sim": SIMULATION})


@app.get("/data")
def data(since: str = "0"):
    try:
        since_ts = float(since)
    except ValueError:
        since_ts = 0.0
    with lock:
        out = dict(state)
        out["series"] = [p for p in series if p["t"] > since_ts]
    out.update(esp32_snapshot())
    return JSONResponse(out)


@app.post("/api/esp32")
async def api_esp32(request: Request):
    """Called by the ESP32 sketch once per second."""
    if config.ESP32_TOKEN:
        key = request.headers.get("x-api-key", "")
        if not hmac.compare_digest(key.encode("utf-8"), config.ESP32_TOKEN.encode("utf-8")):
            return bad("missing or wrong X-API-Key (API_KEY in the sketch must equal ESP32_TOKEN in config.py)", 401)
    d = await get_json(request)
    try:
        adc = int(round(float(d.get("adc"))))
    except (TypeError, ValueError, OverflowError):
        return bad("adc must be a number")
    if not 0 <= adc <= config.ESP32_ADC_MAX:
        return bad(f"adc must be 0-{config.ESP32_ADC_MAX}")

    def num(key, lo, hi):
        try:
            v = float(d.get(key))
        except (TypeError, ValueError, OverflowError):
            return None
        return v if lo <= v <= hi else None

    now = time.time()
    clean = num("clean_air", 0, config.ESP32_ADC_MAX)
    uptime = num("uptime_s", 0, 10 ** 9)
    rssi = num("rssi", -120, 0)
    with esp_lock:
        esp32.update(adc=adc, ts=now, clean_air=clean, calibrating=bool(d.get("calibrating")),
                     boot_ts=None if uptime is None else now - uptime,
                     ip=request.client.host if request.client else None,
                     rssi=None if rssi is None else int(rssi))
    return JSONResponse({"ok": True})


@app.post("/control")
async def control(request: Request):
    d = await get_json(request)
    action, value = d.get("action"), d.get("value")
    if action in ("buzzer", "led"):
        if value not in ("auto", "on", "off"):
            return bad("value must be auto, on or off")
        with lock:
            ctrl[action] = value
    elif action == "mute":
        with lock:
            ctrl["muted"] = True
    elif action == "reset":
        with lock:
            ctrl.update(buzzer="auto", led="auto", muted=False)
    elif action in ("arm", "disarm"):
        with lock:
            settings["armed"] = action == "arm"
            state["armed"] = settings["armed"]
            if action == "disarm":
                ctrl["muted"] = False
        save_settings()
    elif action == "reset_alarm":
        with lock:
            ctrl["gas_latch"] = False
            g_prev = state.get("gas")
            # ignore gas until it has fallen clearly below the threshold (and stayed there); if it is already low, nothing to ignore
            ctrl["gas_ack"] = g_prev is not None and g_prev > settings["threshold"] * getattr(config, "GAS_REARM_RATIO", 0.9)
            ctrl["gas_ok_since"] = None
            ctrl["reset_gen"] += 1
            ctrl["vib_start"] = 0.0         # vibration alarm off right now
            # vibration up to now no longer counts, and new vibration only counts once the sensor has been quiet
            # for VIB_SETTLE_SECONDS (the button press itself shakes the sensor; a stuck sensor must not re-alarm)
            ctrl["vib_ack"] = time.time()
            ctrl["vib_wait"] = True
            ctrl["muted"] = False
            ctrl["warn_ack"] = True         # back to the normal colour now, even if the gas is still elevated
            # answer right away: do not wait for the next sensor loop (up to SAMPLE_INTERVAL) to clear the state
            state.update(gas_alarm=False, vib_alarm=False, vib_left=0, reasons=[])
            if state.get("status") == "danger":
                g_now, thr_now = state.get("gas"), settings["threshold"]
                state["status"] = "safe"
            fast_buzzer_off = ctrl["buzzer"] == "auto"
            if fast_buzzer_off:
                state["buzzer_on"] = False
        if fast_buzzer_off:
            try:
                hw.set_output("buzzer", False)
            except Exception:
                pass                        # the sensor loop reports output errors
    elif action == "threshold":
        try:
            t = int(value)
        except (TypeError, ValueError):
            return bad("threshold must be a number")
        if not 1 <= t <= 1023:
            return bad("threshold must be 1-1023")
        with lock:
            settings["threshold"] = t
        save_settings()
    elif action == "test_email":
        if not config.EMAIL_ENABLED:
            return bad("Turn on email alerts in Settings first")
        threading.Thread(target=send_email, args=(
            "Test email from Gas & Vibration Monitor",
            "If you can read this, email alerts work."), daemon=True).start()
    elif action == "sim_gas" and SIMULATION:
        hw.sim_gas_until = time.time() + 10
        with lock:
            ctrl["sim_skip_warmup"] = True     # test button: do not wait for the MQ-2 warm-up
            ctrl["gas_ack"] = False            # test button: alarm again even right after "Reset alarm"
    elif action == "sim_vibration" and SIMULATION:
        with lock:
            ctrl["vib_ack"] = min(ctrl["vib_ack"], time.time() - 0.01)   # test button: skip the post-reset grace
            ctrl["vib_wait"] = False                                      # test button: do not wait for a quiet sensor
        hw.vib_event = time.time()
    else:
        return bad("unknown action")
    return JSONResponse({"ok": True})


def resolve_range(request):
    """Return (start, end) epoch seconds from ?range=<sec|all> or ?start=&end="""
    q = request.query_params
    now = int(time.time())
    rng = q.get("range")
    try:
        if rng == "all":
            return 0, now + 60
        if rng:
            return now - int(rng), now + 60
        return int(q.get("start", 0)), int(q.get("end", now + 60))
    except ValueError:
        return now - 3600, now + 60


@app.get("/api/history")
def api_history(request: Request):
    start, end = resolve_range(request)
    if start <= 0:
        r = db_query("SELECT MIN(ts) AS m FROM readings WHERE ts < ?", (end,))
        start = r[0]["m"] or end
    bucket = max(1, (end - start) // 600)          # about 600 chart points max
    chart = db_query(
        "SELECT (ts / ?) * ? AS t, ROUND(AVG(gas)) AS gas, MAX(vib) AS vib, ROUND(AVG(vib) * 100) AS vib_pct "
        "FROM readings WHERE ts >= ? AND ts < ? GROUP BY t ORDER BY t",
        (bucket, bucket, start, end))
    rows = db_query(
        "SELECT ts, gas, vib, status FROM readings WHERE ts >= ? AND ts < ? "
        "ORDER BY ts DESC LIMIT 100", (start, end))
    alerts = db_query(
        "SELECT ts, kind, message, email_sent FROM alerts WHERE ts >= ? AND ts < ? "
        "ORDER BY ts DESC LIMIT 100", (start, end))
    stats = db_query(
        "SELECT COUNT(*) AS n, MAX(gas) AS max_gas, ROUND(AVG(gas)) AS avg_gas, "
        "SUM(vib) AS vib_samples FROM readings WHERE ts >= ? AND ts < ?", (start, end))[0]
    return JSONResponse({"chart": chart, "rows": rows, "alerts": alerts, "stats": stats,
                         "threshold": settings["threshold"]})


@app.get("/export.csv")
def export_csv(request: Request):
    start, end = resolve_range(request)
    rows = db_query("SELECT ts, gas, vib, status FROM readings WHERE ts >= ? AND ts < ? "
                    "ORDER BY ts", (start, end))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["timestamp", "gas_adc_0_1023", "vibration", "status"])
    for r in rows:
        w.writerow([datetime.fromtimestamp(r["ts"]).strftime("%Y-%m-%d %H:%M:%S"),
                    r["gas"], r["vib"], r["status"]])
    return Response(buf.getvalue(), media_type="text/csv", headers={
        "Content-Disposition": "attachment; filename=sensor_log.csv"})


@app.get("/api/email")
def api_email_get():
    def shown(v):
        return "" if v in PLACEHOLDER_EMAILS else v
    return JSONResponse({"enabled": bool(config.EMAIL_ENABLED), "user": shown(config.SMTP_USER),
                         "to": shown(config.EMAIL_TO), "host": config.SMTP_HOST,
                         "port": config.SMTP_PORT, "has_password": bool(config.SMTP_PASSWORD)})


@app.post("/api/email")
async def api_email_set(request: Request):
    d = await get_json(request)
    enabled = bool(d.get("enabled"))
    user, to = str(d.get("user") or "").strip(), str(d.get("to") or "").strip()
    host = str(d.get("host") or "").strip() or config.SMTP_HOST
    password = str(d.get("password") or "")
    try:
        port = int(d.get("port") or config.SMTP_PORT)
    except (TypeError, ValueError):
        return bad("The SMTP port must be a number")
    if not 1 <= port <= 65535:
        return bad("The SMTP port must be between 1 and 65535")
    ok_mail = lambda s: bool(_re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", s))
    if user and not ok_mail(user):
        return bad("Enter a valid address to send alerts from")
    if to and not ok_mail(to):
        return bad("Enter a valid address to send alerts to")
    if enabled and not (user and to):
        return bad("Enter both email addresses to turn email alerts on")
    if enabled and not (password or config.SMTP_PASSWORD):
        return bad("Enter the app password to turn email alerts on")
    with lock:
        email_file.update(enabled=enabled, user=user, to=to, host=host, port=port)
        if password:
            email_file["password"] = password
        apply_email()
        state["email_enabled"] = config.EMAIL_ENABLED
        state["email_status"] = "Email alerts are on" if enabled else "Email alerts are off"
    save_email_settings()
    return JSONResponse({"ok": True})


def local_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "<pi-ip-address>"


if __name__ == "__main__":
    import uvicorn
    print("=" * 60)
    print("Mode:", "SIMULATION (Pi outputs faked)" if SIMULATION else "REAL SENSORS")
    print("Gas sensor: MQ-2 on the ESP32 -> POST http://<this-ip>:%d/api/esp32" % config.PORT)
    print(f"Open on this device : http://localhost:{config.PORT}")
    print(f"Open from other PCs : http://{local_ip()}:{config.PORT}")
    print("=" * 60)
    # Run ONE process, no reload: a 2nd process would try to claim the same GPIO pins
    # ("GPIO busy") and would have its own copy of the ESP32 readings.
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="info", access_log=False)
