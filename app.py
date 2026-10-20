"""
Gas & Vibration Monitoring Dashboard - Raspberry Pi 5 + FastAPI (MQ-2 read through an ADS1115)
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
from starlette.middleware.gzip import GZipMiddleware
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
    s = {"threshold": config.DEFAULT_GAS_THRESHOLD, "armed_gas": True, "armed_vib": True}
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
        # gas and vibration used to share one "armed" flag (pre patch14 settings.json): seed both from it once.
        legacy_armed = bool(d.get("armed", True))
        s["armed_gas"] = bool(d.get("armed_gas", legacy_armed))
        s["armed_vib"] = bool(d.get("armed_vib", legacy_armed))
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
def _connect():
    """One short-lived connection. The database is in WAL mode (see init_db) and synchronous=NORMAL means a
    commit no longer waits for the SD card to flush every time: far less stutter on a Raspberry Pi."""
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.execute("PRAGMA synchronous=NORMAL")
    return c


def db_exec(sql, args=()):
    with closing(_connect()) as c:
        cur = c.execute(sql, args)
        c.commit()
        return cur.lastrowid


def db_query(sql, args=()):
    with closing(_connect()) as c:
        c.row_factory = sqlite3.Row
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def init_db():
    with closing(_connect()) as c:
        try:
            c.execute("PRAGMA journal_mode=WAL")    # the History page can read while the logger writes
        except sqlite3.DatabaseError:
            pass
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
        load_series_from_db(c)


def load_series_from_db(c):
    """Fill the in-memory series (Live page graphs) from the last GRAPH_POINTS readings on disk,
    so a restart of app.py does not show blank graphs on the Live page. History already reads the
    database directly and was never affected by this."""
    try:
        c.row_factory = sqlite3.Row
        rows = c.execute(
            "SELECT ts, gas, vib FROM readings ORDER BY ts DESC LIMIT ?",
            (config.GRAPH_POINTS,)).fetchall()
        for r in reversed(rows):
            series.append({"t": float(r["ts"]), "gas": r["gas"], "vib": int(r["vib"] or 0)})
    except Exception as e:
        print("[db] could not load previous readings into the live graph:", e)


# ---- batched logging: one commit per LOG_FLUSH_SECONDS instead of one connection + commit per reading
LOG_FLUSH_SECONDS = 10
_log_buf = []
_log_lock = threading.Lock()
_log_state = {"flush": time.time(), "prune": time.time()}


def flush_readings():
    with _log_lock:
        rows = _log_buf[:]
        del _log_buf[:]
    if not rows:
        return
    try:
        with closing(_connect()) as c:
            c.executemany("INSERT INTO readings(ts, gas, vib, status) VALUES(?,?,?,?)", rows)
            c.commit()
    except Exception as e:
        print("[db] could not write readings:", e)
        with _log_lock:
            _log_buf[:0] = rows[-300:]      # try again next time, but never grow without limit


def prune_old():
    """Delete rows older than RETENTION_DAYS (init_db only did this at start-up)."""
    try:
        cutoff = int(time.time() - config.RETENTION_DAYS * 86400)
        with closing(_connect()) as c:
            c.execute("DELETE FROM readings WHERE ts < ?", (cutoff,))
            c.execute("DELETE FROM alerts WHERE ts < ?", (cutoff,))
            c.commit()
    except Exception as e:
        print("[db] could not prune old rows:", e)


def log_reading(now, gas, vib, status):
    with _log_lock:
        _log_buf.append((int(now), gas, vib, status))
    if now - _log_state["flush"] >= LOG_FLUSH_SECONDS:
        _log_state["flush"] = now
        flush_readings()
    if now - _log_state["prune"] >= 6 * 3600:
        _log_state["prune"] = now
        prune_old()


atexit.register(flush_readings)


# ----------------------------------------------------------------- ads1115 input  (ads1115-patch)
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


def effective_threshold():
    """Alarm level in 0-1023 counts (gas-relative-patch).
    The saved threshold, but never higher than (calibrated clean-air level + GAS_RISE_COUNTS).
    An MQ-2 baseline differs per sensor, so a fixed number (e.g. 400) may never be reached by alcohol or smoke."""
    t = settings["threshold"]
    rise = getattr(config, "GAS_RISE_COUNTS", 0)
    clean = cal["clean_mv"]
    if rise and clean is not None:
        t = min(t, mv_to_counts(clean) + int(rise))
    return max(1, int(t))


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
        self._init("gas", lambda: ADS1115(config.ADS_I2C_BUS, config.ADS_ADDRESS, config.ADS_CHANNEL))
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
        "vib_active": False,  # vibration alarm is on right now (buzzer/LED/pop-up), regardless of the countdown below
        "vib_start": 0.0,     # 0 = the 1-min countdown is not running yet; >0 = countdown running, started at this time
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
    "armed_gas": settings["armed_gas"], "armed_vib": settings["armed_vib"], "last_vib": None,
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
                thr = effective_threshold()     # gas-relative-patch
                warm = 0 if (SIMULATION and ctrl.get("sim_skip_warmup")) else warmup_left(now)
                armed_gas = settings["armed_gas"]
                armed_vib = settings["armed_vib"]
                gas_hit = armed_gas and gas is not None and warm == 0 and gas > thr
                if not armed_gas:
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
                gas_alarm = bool(armed_gas and ctrl["gas_latch"])
                if gas is not None and gas <= thr * 0.7:
                    ctrl["warn_ack"] = False        # gas is really low again: warnings work normally again
                gas_warn = armed_gas and gas is not None and warm == 0 and gas > thr * 0.7 and not ctrl["warn_ack"]
                # vibration: the alarm turns on immediately on the first (un-ignored) vibration pulse, exactly
                # as before (buzzer/LED/pop-up are not delayed). What changed is the 1-minute auto-clear timer:
                # it does NOT start counting down while the sensor keeps shaking. It only starts once the sensor
                # has been quiet for VIB_QUIET_SECONDS; a new pulse before or during the countdown cancels it and
                # the quiet wait starts over. The alarm turns off when a full countdown finishes uninterrupted,
                # or on "Reset alarm", or while disarmed.
                hold = config.VIB_ALARM_HOLD
                settle = getattr(config, "VIB_SETTLE_SECONDS", 2.0)
                quiet_needed = getattr(config, "VIB_QUIET_SECONDS", 5.0)
                if not armed_vib:
                    ctrl["vib_active"] = False
                    ctrl["vib_start"] = 0.0
                    ctrl["vib_ack"] = now
                    ctrl["vib_wait"] = True
                else:
                    if ctrl["vib_start"] and now - ctrl["vib_start"] >= hold:
                        # a full, uninterrupted 60 s quiet countdown finished: alarm off
                        ctrl["vib_active"] = False
                        ctrl["vib_start"] = 0.0
                        ctrl["vib_ack"] = now
                        ctrl["vib_wait"] = True     # a sensor that is STILL vibrating must not restart the alarm at once
                    if ctrl["vib_wait"]:
                        ctrl["vib_ack"] = max(ctrl["vib_ack"], last_vib)   # vibration seen while waiting is thrown away
                        if now - last_vib >= settle:
                            ctrl["vib_wait"] = False   # quiet long enough: only NEW vibration may alarm now
                    if not ctrl["vib_wait"] and not ctrl["vib_active"] and last_vib > ctrl["vib_ack"]:
                        ctrl["vib_active"] = True      # alarm on now; the countdown below only starts once it is quiet
                        ctrl["vib_start"] = 0.0
                    if ctrl["vib_active"]:
                        quiet_for = now - last_vib
                        if quiet_for < quiet_needed:
                            ctrl["vib_start"] = 0.0     # still shaking (or too recent): countdown must not run yet
                        elif not ctrl["vib_start"]:
                            # just became quiet for long enough: start the countdown from the moment that happened,
                            # not from "now", so the full 60 s is not shortened/lengthened by the sensor loop's tick
                            ctrl["vib_start"] = last_vib + quiet_needed
                vib_alarm = bool(armed_vib and ctrl["vib_active"])
                vib_left = max(0, int(math.ceil(hold - (now - ctrl["vib_start"])))) if (vib_alarm and ctrl["vib_start"]) else (hold if vib_alarm else 0)
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
            elif not armed_gas and not armed_vib:
                status = "disarmed"      # only when BOTH sensors are off; with one still armed, its own status applies
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
                    uptime=int(now - START_TIME), ts=now, armed_gas=armed_gas, armed_vib=armed_vib,
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
                log_reading(now, gas, int(vibration), status)
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


class CachedStatic(StaticFiles):
    """Static files. A URL with ?v=<file modified time> (see asset() below) can never change, so the browser keeps it
    for a year and never asks again. Without ?v= the browser re-checks with the ETag (a cheap 304)."""
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if resp.status_code in (200, 304):
            versioned = b"v=" in scope.get("query_string", b"")
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable" if versioned else "no-cache"
        return resp


# only answers > 1.5 KB are compressed (the small once-a-second /data answers are not); level 3 = light on the Pi CPU
app.add_middleware(GZipMiddleware, minimum_size=1500, compresslevel=3)
app.mount("/static", CachedStatic(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))


def asset(name):
    """/static/<name>?v=<modified time>: the URL changes by itself whenever the file changes."""
    try:
        return "/static/%s?v=%d" % (name, int(os.stat(os.path.join(BASE_DIR, "static", name)).st_mtime))
    except OSError:
        return "/static/" + name


templates.env.globals["asset"] = asset


async def get_json(request):
    """Body as a dict, or {} if it is missing or not a JSON object."""
    try:
        d = await request.json()
    except Exception:
        return {}
    return d if isinstance(d, dict) else {}


def bad(message, code=400):
    return JSONResponse({"ok": False, "error": message}, status_code=code)


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return Response(status_code=204, headers={"Cache-Control": "public, max-age=604800"})


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
        new = []
        for p in reversed(series):          # newest first: stop at the first sample the browser already has
            if p["t"] <= since_ts:
                break
            new.append(p)
        new.reverse()
        out["series"] = new
    out.update(gas_snapshot())
    return JSONResponse(out)


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
    elif action in ("arm", "disarm", "arm_gas", "disarm_gas", "arm_vib", "disarm_vib"):
        with lock:
            disarming_anything = False
            if action in ("arm", "disarm"):                       # old action: both sensors together
                settings["armed_gas"] = settings["armed_vib"] = action == "arm"
                disarming_anything = action == "disarm"
            elif action in ("arm_gas", "disarm_gas"):
                settings["armed_gas"] = action == "arm_gas"
                disarming_anything = action == "disarm_gas"
            else:
                settings["armed_vib"] = action == "arm_vib"
                disarming_anything = action == "disarm_vib"
            state["armed_gas"] = settings["armed_gas"]
            state["armed_vib"] = settings["armed_vib"]
            if disarming_anything:
                ctrl["muted"] = False
        save_settings()
    elif action == "reset_alarm":
        with lock:
            ctrl["gas_latch"] = False
            g_prev = state.get("gas")
            # ignore gas until it has fallen clearly below the threshold (and stayed there); if it is already low, nothing to ignore
            ctrl["gas_ack"] = g_prev is not None and g_prev > effective_threshold() * getattr(config, "GAS_REARM_RATIO", 0.9)
            ctrl["gas_ok_since"] = None
            ctrl["reset_gen"] += 1
            ctrl["vib_active"] = False       # vibration alarm off right now
            ctrl["vib_start"] = 0.0
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
    elif action == "calibrate":
        calibration_start()
    elif action == "calibrate_cancel":
        calibration_cancel()
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
    with closing(_connect()) as c:
        c.row_factory = sqlite3.Row
        agg = c.execute(
            "SELECT (ts / ?) * ? AS t, COUNT(*) AS n, COUNT(gas) AS ng, SUM(gas) AS sg, MAX(gas) AS mg, "
            "ROUND(AVG(gas)) AS gas, MAX(vib) AS vib, ROUND(AVG(vib) * 100) AS vib_pct, SUM(vib) AS sv "
            "FROM readings WHERE ts >= ? AND ts < ? GROUP BY t ORDER BY t",
            (bucket, bucket, start, end)).fetchall()
        rows = [dict(r) for r in c.execute(
            "SELECT ts, gas, vib, status FROM readings WHERE ts >= ? AND ts < ? "
            "ORDER BY ts DESC LIMIT 100", (start, end))]
        alerts = [dict(r) for r in c.execute(
            "SELECT ts, kind, message, email_sent FROM alerts WHERE ts >= ? AND ts < ? "
            "ORDER BY ts DESC LIMIT 100", (start, end))]
    chart = [{"t": r["t"], "gas": r["gas"], "vib": r["vib"], "vib_pct": r["vib_pct"]} for r in agg]
    n_all = sum(r["n"] for r in agg)
    n_gas = sum(r["ng"] for r in agg)
    stats = {"n": n_all,
             "max_gas": max((r["mg"] for r in agg if r["mg"] is not None), default=None),
             "avg_gas": int(sum(r["sg"] or 0 for r in agg) / n_gas + 0.5) if n_gas else None,
             "vib_samples": sum(r["sv"] or 0 for r in agg) if n_all else None}
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
    print("Gas sensor: MQ-2 -> ADS1115 (I2C bus %d, address 0x%02X, A%d)" % (config.ADS_I2C_BUS, config.ADS_ADDRESS, config.ADS_CHANNEL))
    print(f"Open on this device : http://localhost:{config.PORT}")
    print(f"Open from other PCs : http://{local_ip()}:{config.PORT}")
    print("=" * 60)
    # Run ONE process, no reload: a 2nd process would try to claim the same GPIO pins
    # ("GPIO busy") and would have its own copy of the sensor readings.
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="info", access_log=False)
