"""
Gas & Vibration Monitoring Dashboard - Raspberry Pi 5 + Flask
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

from flask import Flask, Response, jsonify, render_template, request

import config

# gpiozero works on the Pi 5 (RPi.GPIO does NOT). It uses the lgpio backend.
try:
    from gpiozero import LED, MCP3008, Buzzer, DigitalInputDevice
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
    try:
        with open(SETTINGS_PATH) as f:
            t = int(json.load(f)["threshold"])
            if 1 <= t <= 1023:
                return {"threshold": t}
    except Exception:
        pass
    return {"threshold": config.DEFAULT_GAS_THRESHOLD}


def save_settings():
    try:
        with open(SETTINGS_PATH, "w") as f:
            json.dump(settings, f)
    except OSError as e:
        print("Could not save settings:", e)


settings = load_settings()


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
        self._init("gas", lambda: MCP3008(channel=config.GAS_ADC_CHANNEL,
                                          device=config.SPI_DEVICE))
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
        """Return the MQ-2 value as 0-1023 (average of 5 reads to reduce noise)."""
        if SIMULATION:
            t = time.time()
            v = 180 + 25 * math.sin(t / 7) + random.uniform(-8, 8)
            if t < self.sim_gas_until:
                v += 450
            return int(max(0, min(1023, v)))
        if self.gas is None:
            raise RuntimeError(self.errors.get("gas", "ADC not initialised") +
                               " (is SPI enabled? check wiring)")
        total = 0.0
        for _ in range(5):
            total += self.gas.value
            time.sleep(0.005)
        return int(round(total / 5 * 1023))

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
ctrl = {"buzzer": "auto", "led": "auto", "muted": False}
series = deque(maxlen=config.GRAPH_POINTS)
state = {
    "gas": None, "gas_voltage": None, "vibration": False, "status": "warmup",
    "reasons": [], "threshold": settings["threshold"],
    "warmup_left": config.WARMUP_SECONDS, "buzzer_on": False, "led_on": False,
    "buzzer_mode": "auto", "led_mode": "auto", "muted": False, "errors": [],
    "last_alert": None, "last_email": None,
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
                thr = settings["threshold"]
                warm = max(0.0, config.WARMUP_SECONDS - (now - START_TIME))
                gas_alarm = gas is not None and warm == 0 and gas > thr
                gas_warn = gas is not None and warm == 0 and gas > thr * 0.7
                alarm = gas_alarm or vibration
                if not alarm:
                    ctrl["muted"] = False       # mute lasts until the alarm ends
                reasons = []
                if gas_alarm:
                    reasons.append(f"Gas level {gas} is above the threshold {thr}")
                if vibration:
                    reasons.append("Vibration detected")
                bz, ld = ctrl["buzzer"], ctrl["led"]
                buzzer_on = (bz == "on") or (bz == "auto" and alarm and not ctrl["muted"])
                led_on = (ld == "on") or (ld == "auto" and vibration)
                muted, bz_mode, led_mode = ctrl["muted"], bz, ld

            for name, on in (("buzzer", buzzer_on), ("led", led_on)):
                try:
                    hw.set_output(name, on)
                except Exception as e:
                    errors.append(f"{name.upper()} error: {e}")

            if alarm:
                status = "danger"
            elif errors:
                status = "error"
            elif warm > 0:
                status = "warmup"
            elif gas_warn:
                status = "warning"
            else:
                status = "safe"

            with lock:
                state.update(
                    gas=gas,
                    gas_voltage=None if gas is None else round(
                        gas / 1023 * 3.3 * config.ADC_DIVIDER_RATIO, 2),
                    vibration=vibration, status=status, reasons=reasons,
                    threshold=thr, warmup_left=int(math.ceil(warm)),
                    buzzer_on=buzzer_on, led_on=led_on, buzzer_mode=bz_mode,
                    led_mode=led_mode, muted=muted, errors=errors,
                    uptime=int(now - START_TIME), ts=now)
                series.append({"t": round(now, 1), "gas": gas, "vib": int(vibration)})

            # ---- alert when an alarm starts, or a 2nd alarm type joins in
            active = {k for k, on in (("Gas", gas_alarm), ("Vibration", vibration)) if on}
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


# ----------------------------------------------------------------- web app
app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html", sim=SIMULATION, warmup_total=config.WARMUP_SECONDS)


@app.route("/history")
def history_page():
    return render_template("history.html", sim=SIMULATION)


@app.route("/data")
def data():
    try:
        since = float(request.args.get("since", 0))
    except ValueError:
        since = 0.0
    with lock:
        out = dict(state)
        out["series"] = [p for p in series if p["t"] > since]
    return jsonify(out)


@app.post("/control")
def control():
    d = request.get_json(silent=True) or {}
    action, value = d.get("action"), d.get("value")
    if action in ("buzzer", "led"):
        if value not in ("auto", "on", "off"):
            return jsonify(ok=False, error="value must be auto, on or off"), 400
        with lock:
            ctrl[action] = value
    elif action == "mute":
        with lock:
            ctrl["muted"] = True
    elif action == "reset":
        with lock:
            ctrl.update(buzzer="auto", led="auto", muted=False)
    elif action == "threshold":
        try:
            t = int(value)
        except (TypeError, ValueError):
            return jsonify(ok=False, error="threshold must be a number"), 400
        if not 1 <= t <= 1023:
            return jsonify(ok=False, error="threshold must be 1-1023"), 400
        with lock:
            settings["threshold"] = t
        save_settings()
    elif action == "test_email":
        if not config.EMAIL_ENABLED:
            return jsonify(ok=False, error="Set EMAIL_ENABLED = True in config.py"), 400
        threading.Thread(target=send_email, args=(
            "Test email from Gas & Vibration Monitor",
            "If you can read this, email alerts work."), daemon=True).start()
    elif action == "sim_gas" and SIMULATION:
        hw.sim_gas_until = time.time() + 10
    elif action == "sim_vibration" and SIMULATION:
        hw.vib_event = time.time()
    else:
        return jsonify(ok=False, error="unknown action"), 400
    return jsonify(ok=True)


def resolve_range():
    """Return (start, end) epoch seconds from ?range=<sec|all> or ?start=&end="""
    now = int(time.time())
    rng = request.args.get("range")
    try:
        if rng == "all":
            return 0, now + 60
        if rng:
            return now - int(rng), now + 60
        return int(request.args.get("start", 0)), int(request.args.get("end", now + 60))
    except ValueError:
        return now - 3600, now + 60


@app.route("/api/history")
def api_history():
    start, end = resolve_range()
    if start <= 0:
        r = db_query("SELECT MIN(ts) AS m FROM readings WHERE ts < ?", (end,))
        start = r[0]["m"] or end
    bucket = max(1, (end - start) // 600)          # about 600 chart points max
    chart = db_query(
        "SELECT (ts / ?) * ? AS t, ROUND(AVG(gas)) AS gas, MAX(vib) AS vib "
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
    return jsonify(chart=chart, rows=rows, alerts=alerts, stats=stats, threshold=settings["threshold"])


@app.route("/export.csv")
def export_csv():
    start, end = resolve_range()
    rows = db_query("SELECT ts, gas, vib, status FROM readings WHERE ts >= ? AND ts < ? "
                    "ORDER BY ts", (start, end))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["timestamp", "gas_adc_0_1023", "vibration", "status"])
    for r in rows:
        w.writerow([datetime.fromtimestamp(r["ts"]).strftime("%Y-%m-%d %H:%M:%S"),
                    r["gas"], r["vib"], r["status"]])
    return Response(buf.getvalue(), mimetype="text/csv", headers={
        "Content-Disposition": "attachment; filename=sensor_log.csv"})


def local_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "<pi-ip-address>"


if __name__ == "__main__":
    init_db()
    threading.Thread(target=sensor_loop, daemon=True).start()
    print("=" * 60)
    print("Mode:", "SIMULATION (fake data)" if SIMULATION else "REAL SENSORS")
    print(f"Open on this device : http://localhost:{config.PORT}")
    print(f"Open from other PCs : http://{local_ip()}:{config.PORT}")
    print("=" * 60)
    # debug/reloader MUST stay off: the reloader starts a 2nd process that would
    # try to claim the same GPIO pins and crash ("GPIO busy").
    app.run(host=config.HOST, port=config.PORT, debug=False, use_reloader=False, threaded=True)
