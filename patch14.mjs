#!/usr/bin/env node
/**
 * patch14.mjs - act4embed, fourteenth round: three behaviour changes requested on top of patch13
 * (commit "Frontend optimization", c9e4a66).
 *
 * 1) GAS AND VIBRATION ARE ARMED SEPARATELY
 *    Before: one "Arm / Disarm" button controlled both sensors together (settings.armed / state.armed).
 *    Now: two independent switches, settings.armed_gas and settings.armed_vib, each with its own button
 *    ("Gas: Armed/Disarmed", "Vibration: Armed/Disarmed") in the Live page hero. /control gets four new
 *    actions: arm_gas, disarm_gas, arm_vib, disarm_vib. The old arm/disarm actions still work and now
 *    apply to both sensors together, so any old client or saved shortcut keeps working. A settings.json
 *    saved by the old app (only "armed") is read as both sensors sharing that one value, once.
 *
 * 2) LIVE-PAGE GRAPHS AND STATE SURVIVE A RESTART
 *    Before: `series` (the in-memory buffer the Live page graphs are drawn from) started empty every time
 *    app.py was (re)started, so the gas/vibration graphs on the Live page looked blank after every restart
 *    even though the readings were sitting in sensor.db all along (History already read the database
 *    correctly - only the Live page's live buffer was memory-only). Now init_db() loads the most recent
 *    GRAPH_POINTS readings from sensor.db straight into `series` at start-up, so the Live page's graphs
 *    pick up right where they left off. The database write path (log_reading/flush_readings, WAL, batched
 *    commit, atexit flush) was already correct and is unchanged.
 *
 * 3) VIBRATION: DON'T START THE 1-MINUTE COUNTDOWN WHILE STILL SHAKING
 *    Before: the first vibration pulse started both the alarm AND its own 60 s (VIB_ALARM_HOLD) countdown
 *    to auto-clear; more vibration during that minute changed nothing.
 *    Now: the first pulse still turns the alarm on immediately (buzzer/LED/pop-up unchanged), but the 60 s
 *    countdown does not start yet. The code waits for the sensor to be quiet for VIB_QUIET_SECONDS (5 s);
 *    only then does the 60 s countdown begin. Any new pulse before or during the countdown cancels the
 *    countdown and the 5 s quiet wait starts over. The alarm itself only turns off when a full 60 s
 *    countdown finishes without being restarted, or "Reset alarm" is pressed, or the sensor is disarmed.
 *
 *    Files changed: config.py, app.py, templates/index.html
 *
 * Apply on top of patch13 (commit "Frontend optimization", c9e4a66).
 *
 * Usage (from the repo root, next to app.py):
 *     node patch14.mjs --dry-run   check only, writes nothing
 *     node patch14.mjs
 * If an anchor doesn't match, NOTHING is written. Backups go to .patch14-backup/
 * Undo with:  git checkout -- config.py app.py templates/index.html
 * Then restart the app (stop the old python first!) and hard-refresh the browser (Ctrl+F5).
 *
 * NOTE ON EXISTING DATA: settings.json currently stores one "armed" flag. After this patch it is read
 * once as the starting value for BOTH armed_gas and armed_vib, then app.py starts saving armed_gas /
 * armed_vib separately. Nothing needs to be deleted; this happens automatically the first time you run
 * the patched app.py.
 */
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry-run');
const ROOT = process.cwd();
const out = new Map();

function fail(msg) { console.error('\nPATCH ABORTED, nothing was written.\n  ' + msg); process.exit(1); }

function load(rel) {
  if (out.has(rel)) return out.get(rel);
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) fail(rel + ' not found. Run this from the repo root (next to app.py).');
  const raw = fs.readFileSync(p, 'utf8');
  const e = { text: raw.replace(/\r\n/g, '\n'), crlf: raw.includes('\r\n'), raw };
  out.set(rel, e);
  return e;
}

function once(rel, find, repl) {
  const e = load(rel);
  const i = e.text.indexOf(find);
  if (i < 0) fail(rel + ': anchor not found:\n  ' + find.split('\n')[0].trim());
  if (e.text.indexOf(find, i + 1) >= 0) fail(rel + ': anchor is not unique:\n  ' + find.split('\n')[0].trim());
  e.text = e.text.slice(0, i) + repl + e.text.slice(i + find.length);
}

// replace everything from `from` up to (not including) `to`; both markers must exist, `from` must be unique
function span(rel, from, to, repl) {
  const e = load(rel);
  const i = e.text.indexOf(from);
  if (i < 0) fail(rel + ': start anchor not found:\n  ' + from.split('\n')[0].trim());
  if (e.text.indexOf(from, i + 1) >= 0) fail(rel + ': start anchor is not unique:\n  ' + from.split('\n')[0].trim());
  const j = e.text.indexOf(to, i + from.length);
  if (j < 0) fail(rel + ': end anchor not found:\n  ' + to.split('\n')[0].trim());
  e.text = e.text.slice(0, i) + repl + e.text.slice(j);
}

const app0 = load('app.py').text;
if (app0.includes('VIB_QUIET_SECONDS') || app0.includes('armed_gas')) {
  console.log('Already patched (patch14). Nothing to do.'); process.exit(0);
}
if (!app0.includes('def _connect():')) fail('app.py is not the patch13 version. Pull the latest repo (git pull) first.');

/* ================================================================ config.py */

once('config.py',
String.raw`VIB_SETTLE_SECONDS = 2        # after Reset alarm or the 1-minute timeout, the sensor must be quiet this long before it can alarm again`,
String.raw`VIB_SETTLE_SECONDS = 2        # after Reset alarm or the 1-minute timeout, the sensor must be quiet this long before it can alarm again
VIB_QUIET_SECONDS = 5          # the 1-minute countdown only starts once the sensor has been quiet this long;
                                # any new vibration before or during the countdown restarts this wait`);

/* ================================================================ app.py */

// 1) settings: armed -> armed_gas / armed_vib (old settings.json with one "armed" seeds both, once)
once('app.py',
String.raw`def load_settings():
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
    return s`,
String.raw`def load_settings():
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
    return s`);

// 2) database: load recent readings into `series` at start-up, so the Live page graphs are not blank
//    after a restart (the database itself was already being written to correctly).
once('app.py',
String.raw`def init_db():
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
        c.commit()`,
String.raw`def init_db():
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
        print("[db] could not load previous readings into the live graph:", e)`);

// 3) ctrl: new vib_active flag (the alarm can be on before the 60 s countdown has started)
once('app.py',
String.raw`        "vib_ack": 0.0,       # vibration up to this moment is ignored (Reset alarm, timeout, or while disarmed)
        "vib_start": 0.0,     # when the running vibration alarm started (0 = no vibration alarm)
        "reset_gen": 0,       # +1 on every "Reset alarm": lets the sensor loop see a reset that happened mid-pass
        "vib_wait": False,    # after Reset / 1-min timeout: vibration is ignored until the sensor has been quiet for a while`,
String.raw`        "vib_ack": 0.0,       # vibration up to this moment is ignored (Reset alarm, timeout, or while disarmed)
        "vib_active": False,  # vibration alarm is on right now (buzzer/LED/pop-up), regardless of the countdown below
        "vib_start": 0.0,     # 0 = the 1-min countdown is not running yet; >0 = countdown running, started at this time
        "reset_gen": 0,       # +1 on every "Reset alarm": lets the sensor loop see a reset that happened mid-pass
        "vib_wait": False,    # after Reset / 1-min timeout: vibration is ignored until the sensor has been quiet for a while`);

// 4) state: armed -> armed_gas / armed_vib
once('app.py',
String.raw`    "armed": settings["armed"], "last_vib": None,`,
String.raw`    "armed_gas": settings["armed_gas"], "armed_vib": settings["armed_vib"], "last_vib": None,`);

// 5) sensor loop: gas block reads armed_gas instead of the shared armed flag
once('app.py',
String.raw`                my_gen = ctrl["reset_gen"]
                thr = settings["threshold"]
                warm = 0 if (SIMULATION and ctrl.get("sim_skip_warmup")) else warmup_left(now)
                armed = settings["armed"]
                gas_hit = armed and gas is not None and warm == 0 and gas > thr
                if not armed:
                    ctrl["gas_latch"] = ctrl["gas_ack"] = False`,
String.raw`                my_gen = ctrl["reset_gen"]
                thr = settings["threshold"]
                warm = 0 if (SIMULATION and ctrl.get("sim_skip_warmup")) else warmup_left(now)
                armed_gas = settings["armed_gas"]
                armed_vib = settings["armed_vib"]
                gas_hit = armed_gas and gas is not None and warm == 0 and gas > thr
                if not armed_gas:
                    ctrl["gas_latch"] = ctrl["gas_ack"] = False`);

once('app.py',
String.raw`                gas_alarm = bool(armed and ctrl["gas_latch"])
                if gas is not None and gas <= thr * 0.7:
                    ctrl["warn_ack"] = False        # gas is really low again: warnings work normally again
                gas_warn = armed and gas is not None and warm == 0 and gas > thr * 0.7 and not ctrl["warn_ack"]`,
String.raw`                gas_alarm = bool(armed_gas and ctrl["gas_latch"])
                if gas is not None and gas <= thr * 0.7:
                    ctrl["warn_ack"] = False        # gas is really low again: warnings work normally again
                gas_warn = armed_gas and gas is not None and warm == 0 and gas > thr * 0.7 and not ctrl["warn_ack"]`);

// 6) vibration block: rewritten. Alarm starts immediately on the first (un-ignored) pulse as before, but
//    the 60 s countdown (vib_start) only starts once the sensor has been quiet for VIB_QUIET_SECONDS, and
//    any new pulse - before or during the countdown - cancels it and restarts the quiet wait.
span('app.py',
String.raw`                # vibration: the alarm starts on the first vibration and ends on "Reset alarm" or
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
                vib_left = max(0, int(math.ceil(hold - (now - ctrl["vib_start"])))) if vib_alarm else 0`,
String.raw`                alarm = gas_alarm or vib_alarm`,
String.raw`                # vibration: the alarm turns on immediately on the first (un-ignored) vibration pulse, exactly
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
`);

// 7) status/output code no longer reference the old single `armed` flag
once('app.py',
String.raw`            elif not armed:
                status = "disarmed"`,
String.raw`            elif not armed_gas and not armed_vib:
                status = "disarmed"      # only when BOTH sensors are off; with one still armed, its own status applies`);

once('app.py',
String.raw`                    uptime=int(now - START_TIME), ts=now, armed=armed,`,
String.raw`                    uptime=int(now - START_TIME), ts=now, armed_gas=armed_gas, armed_vib=armed_vib,`);

// 8) /control: split arm/disarm into arm_gas/disarm_gas/arm_vib/disarm_vib; old arm/disarm still
//    work and now apply to both sensors, for backward compatibility with old clients/shortcuts.
once('app.py',
String.raw`    elif action in ("arm", "disarm"):
        with lock:
            settings["armed"] = action == "arm"
            state["armed"] = settings["armed"]
            if action == "disarm":
                ctrl["muted"] = False
        save_settings()`,
String.raw`    elif action in ("arm", "disarm", "arm_gas", "disarm_gas", "arm_vib", "disarm_vib"):
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
        save_settings()`);

// 9) reset_alarm: also clear the new vib_active flag
once('app.py',
String.raw`            ctrl["vib_start"] = 0.0         # vibration alarm off right now`,
String.raw`            ctrl["vib_active"] = False       # vibration alarm off right now
            ctrl["vib_start"] = 0.0`);

/* ================================================================ templates/index.html */

// two independent arm buttons instead of one shared one
once('templates/index.html',
String.raw`    <div class="row"><button class="btn arm" id="armBtn" disabled>Arm / Disarm</button><button class="btn fill" id="muteBtn" hidden>Mute alarm</button></div>`,
String.raw`    <div class="row"><button class="btn arm" id="armGasBtn" disabled>Gas: Arm / Disarm</button><button class="btn arm" id="armVibBtn" disabled>Vibration: Arm / Disarm</button><button class="btn fill" id="muteBtn" hidden>Mute alarm</button></div>`);

once('templates/index.html',
String.raw`let since = 0, busy = false, armed = true, zoom = 1, thr = 400;`,
String.raw`let since = 0, busy = false, armedGas = true, armedVib = true, zoom = 1, thr = 400;`);

once('templates/index.html',
String.raw`  const ab = $('armBtn');
  ab.disabled = false;
  ab.className = 'btn arm ' + (armed ? 'on' : 'off');
  ab.textContent = armed ? 'Disarm' : 'Arm';
  ab.setAttribute('aria-label', armed ? 'System is armed. Press to disarm' : 'System is disarmed. Press to arm');`,
String.raw`  const gb = $('armGasBtn');
  gb.disabled = false;
  gb.className = 'btn arm ' + (armedGas ? 'on' : 'off');
  gb.textContent = 'Gas: ' + (armedGas ? 'Armed' : 'Disarmed');
  gb.setAttribute('aria-label', armedGas ? 'Gas sensor is armed. Press to disarm' : 'Gas sensor is disarmed. Press to arm');

  const vb = $('armVibBtn');
  vb.disabled = false;
  vb.className = 'btn arm ' + (armedVib ? 'on' : 'off');
  vb.textContent = 'Vibration: ' + (armedVib ? 'Armed' : 'Disarmed');
  vb.setAttribute('aria-label', armedVib ? 'Vibration sensor is armed. Press to disarm' : 'Vibration sensor is disarmed. Press to arm');`);

once('templates/index.html',
String.raw`  document.body.dataset.s = d.status;
  armed = d.armed !== false;
  thr = d.threshold;`,
String.raw`  document.body.dataset.s = d.status;
  armedGas = d.armed_gas !== false;
  armedVib = d.armed_vib !== false;
  thr = d.threshold;`);

once('templates/index.html',
String.raw`$('muteBtn').onclick = () => control('mute');
$('armBtn').onclick = () => { $('armBtn').disabled = true; control(armed ? 'disarm' : 'arm'); };`,
String.raw`$('muteBtn').onclick = () => control('mute');
$('armGasBtn').onclick = () => { $('armGasBtn').disabled = true; control(armedGas ? 'disarm_gas' : 'arm_gas'); };
$('armVibBtn').onclick = () => { $('armVibBtn').disabled = true; control(armedVib ? 'disarm_vib' : 'arm_vib'); };`);

/* ================================================================ write */
for (const [rel, e] of out) {
  if (e.text === e.raw.replace(/\r\n/g, '\n')) continue;
  console.log((DRY ? '[dry-run] would patch ' : 'patching ') + rel);
  if (DRY) continue;
  const bak = path.join(ROOT, '.patch14-backup', rel);
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.writeFileSync(bak, e.raw);
  fs.writeFileSync(path.join(ROOT, rel), e.crlf ? e.text.replace(/\n/g, '\r\n') : e.text);
}
console.log(DRY ? '\nDry run OK: all anchors matched.' : '\nDone. Stop the old app.py, then start it again:  python app.py   (and Ctrl+F5 in the browser)');
