#!/usr/bin/env node
/**
 * patch.mjs - act4embed: vibration widget, merged gas widget, arm/disarm, history vibration graph
 *
 * Usage (from the repo root, next to app.py):
 *     node patch.mjs            apply the patch
 *     node patch.mjs --dry-run  check that everything matches, write nothing
 *
 * Written against commit 6f3ab84. Every edit is checked first; if any anchor is missing
 * (you changed those lines) NOTHING is written. Undo with:  git checkout -- .
 */
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry-run');
const ROOT = process.cwd();
const out = new Map(); // file -> {text, crlf}

function fail(msg) { console.error('\nPATCH ABORTED, nothing was written.\n  ' + msg); process.exit(1); }

function load(rel) {
  if (out.has(rel)) return out.get(rel);
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) fail(rel + ' not found. Run this from the repo root (next to app.py).');
  const raw = fs.readFileSync(p, 'utf8');
  const e = { text: raw.replace(/\r\n/g, '\n'), crlf: raw.includes('\r\n') };
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

function between(rel, start, end, repl) {
  const e = load(rel);
  const i = e.text.indexOf(start);
  if (i < 0) fail(rel + ': start marker not found: ' + start.trim());
  const j = e.text.indexOf(end, i);
  if (j < 0) fail(rel + ': end marker not found: ' + end.trim());
  e.text = e.text.slice(0, i) + repl + e.text.slice(j + end.length);
}

// already patched?
if (load('templates/index.html').text.includes('id="armBtn"')) {
  console.log('templates/index.html already contains the arm button - looks patched already. Nothing to do.');
  process.exit(0);
}

/* ==================================================================== app.py */
// 1. settings now remember armed/disarmed (survives a restart)
once('app.py',
`def load_settings():
    try:
        with open(SETTINGS_PATH) as f:
            t = int(json.load(f)["threshold"])
            if 1 <= t <= 1023:
                return {"threshold": t}
    except Exception:
        pass
    return {"threshold": config.DEFAULT_GAS_THRESHOLD}
`,
`def load_settings():
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
`);

// 2. state fields sent to the Live page
once('app.py',
`    "last_alert": None, "last_email": None,
`,
`    "last_alert": None, "last_email": None,
    "armed": settings["armed"], "last_vib": None,
`);

// 3. alarm logic respects armed
once('app.py',
`                gas_alarm = gas is not None and warm == 0 and gas > thr
                gas_warn = gas is not None and warm == 0 and gas > thr * 0.7
                alarm = gas_alarm or vibration
`,
`                armed = settings["armed"]
                gas_alarm = armed and gas is not None and warm == 0 and gas > thr
                gas_warn = armed and gas is not None and warm == 0 and gas > thr * 0.7
                vib_alarm = armed and vibration     # disarmed: still measured, never alarms
                alarm = gas_alarm or vib_alarm
`);
once('app.py',
`                if vibration:
                    reasons.append("Vibration detected")
`,
`                if vib_alarm:
                    reasons.append("Vibration detected")
`);
once('app.py',
`(ld == "auto" and vibration)`,
`(ld == "auto" and vib_alarm)`);

// 4. new status "disarmed"
once('app.py',
`            elif errors:
                status = "error"
`,
`            elif errors:
                status = "error"
            elif not armed:
                status = "disarmed"
`);

// 5. publish armed + last vibration time
once('app.py',
`                    uptime=int(now - START_TIME), ts=now)`,
`                    uptime=int(now - START_TIME), ts=now, armed=armed,
                    last_vib=round(last_vib, 1) if last_vib else None)`);

// 6. alerts only while armed
once('app.py',
`(("Gas", gas_alarm), ("Vibration", vibration))`,
`(("Gas", gas_alarm), ("Vibration", vib_alarm))`);

// 7. /control arm + disarm
once('app.py',
`    elif action == "threshold":
`,
`    elif action in ("arm", "disarm"):
        with lock:
            settings["armed"] = action == "arm"
            state["armed"] = settings["armed"]
            if action == "disarm":
                ctrl["muted"] = False
        save_settings()
    elif action == "threshold":
`);

// 8. history: share of readings with vibration per chart bucket
once('app.py',
`ROUND(AVG(gas)) AS gas, MAX(vib) AS vib "`,
`ROUND(AVG(gas)) AS gas, MAX(vib) AS vib, ROUND(AVG(vib) * 100) AS vib_pct "`);

/* ============================================================== style.css */
{
  const e = load('static/style.css');
  e.text = e.text.replace(/\s*$/, '\n') + String.raw`
/* ambient-widgets: arm/disarm, merged widgets, vibration */
body[data-s=disarmed]{--bg:#2d3236;--ink:#eef1f3}
.wgt{display:flex;flex-direction:column}
.gph{margin-top:auto;padding-top:22px}
.gph h2{margin:0}
.state{display:flex;align-items:center;gap:16px;font:800 clamp(2.2rem,5vw,3.6rem)/1.05 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.03em;margin:6px 0 4px}
.dot{flex:none;width:.4em;height:.4em;border-radius:50%;border:3px solid var(--ink);transition:background .2s}
.dot.on{background:var(--ink);animation:blink 1s ease-in-out infinite}
@keyframes blink{50%{opacity:.35}}
.btn:disabled{opacity:.5;cursor:default}
.chips+.chips{margin-top:10px}
@media(prefers-reduced-motion:reduce){.dot.on{animation:none}}
`;
}

/* ========================================================= templates/index.html */
between('templates/index.html', '  <section aria-live="polite">', '</main>', String.raw`  <section aria-live="polite">
    <h1 class="verdict" id="verdict">Connecting</h1>
    <p class="sub" id="sub">Waiting for the Raspberry Pi.</p>
    <div class="row"><button class="btn fill" id="muteBtn" hidden>Mute alarm</button><button class="btn" id="armBtn" disabled>Arm / Disarm</button></div>
    <div class="chips"><span class="chip on" id="armChip">Armed</span><span class="chip" id="bzChip">Buzzer off</span><span class="chip" id="ledChip">LED off</span></div>
  </section>

  <section class="two">
    <div class="card wgt">
      <span class="lbl">Gas level (MQ-2)</span>
      <div class="num"><span id="gasVal">--</span><small>of 1023</small></div>
      <div class="bar" aria-hidden="true"><i id="gasFill" style="width:0"></i><b id="gasTick"></b></div>
      <div class="bar-note"><span>0</span><span>Alarm at <b id="tickVal">--</b></span><span>1023</span></div>
      <p class="muted">Sensor voltage: <span id="gasVolt">--</span> V</p>
      <p class="muted">Source: <span id="gasSrc">--</span> &middot; raw ADC <span id="gasRaw">--</span> of 4095</p>
      <p class="muted">Clean air baseline: <span id="cleanAir">--</span></p>
      <div class="gph">
        <h2>Gas, last 2 minutes</h2>
        <svg class="trace" id="trace" viewBox="0 0 720 230" preserveAspectRatio="none" role="img" aria-label="Live gas trace"></svg>
        <div class="axis"><span>2 min ago</span><span>Dashed line: alarm threshold</span><span>now</span></div>
      </div>
    </div>

    <div class="card wgt">
      <span class="lbl">Vibration (SW-420)</span>
      <div class="state"><i class="dot" id="vibDot" aria-hidden="true"></i><span id="vibState">--</span></div>
      <p class="muted">Last vibration: <span id="vibLast">--</span></p>
      <p class="muted">A detection stays on screen for a few seconds after the last pulse.</p>
      <div class="gph">
        <h2>Vibration, last 2 minutes</h2>
        <svg class="trace" id="vtrace" viewBox="0 0 720 120" preserveAspectRatio="none" role="img" aria-label="Live vibration trace" style="height:120px"></svg>
        <div class="axis"><span>2 min ago</span><span>High = vibration detected</span><span>now</span></div>
      </div>
    </div>
  </section>
`);

between('templates/index.html', '<script>', '</script>', String.raw`<script>
const $ = id => document.getElementById(id);
const H = [], HV = [];
let since = 0, busy = false, armed = true;
const TXT = {
  safe: ['All clear', 'Gas and vibration are both normal.'],
  warning: ['Gas is rising', 'The level is close to the alarm threshold.'],
  error: ['Sensor problem', 'A sensor is not responding. See the message above.'],
  disarmed: ['Disarmed', 'Alarm, buzzer and email alerts are off. Readings are still shown.']
};
const fmt = sec => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
function list(ul, items) { ul.replaceChildren(...items.map(t => { const li = document.createElement('li'); li.textContent = t; return li; })); }
function ago(s) {
  s = Math.max(0, s);
  return s < 60 ? Math.round(s) + ' s ago' : s < 3600 ? Math.floor(s / 60) + ' min ago' : Math.floor(s / 3600) + ' h ago';
}

function drawTrace(thr) {
  const w = 720, h = 230, n = H.length;
  if (!n) return;
  const x = i => (i + 240 - n) / 239 * w, y = g => h - g / 1023 * h;
  let p = '';
  H.forEach((q, i) => { p += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(q.g).toFixed(1); });
  $('trace').innerHTML =
      '<path class="ar" d="' + p + 'L' + w + ' ' + h + 'L' + x(0).toFixed(1) + ' ' + h + 'Z"/>'
    + '<line class="th" x1="0" x2="' + w + '" y1="' + y(thr) + '" y2="' + y(thr) + '"/>'
    + '<path class="ln" d="' + p + '"/>';
}

function drawVib() {
  const w = 720, h = 120, n = HV.length;
  if (!n) return;
  const x = i => (i + 240 - n) / 239 * w, Y = v => v ? 12 : h - 4;
  let p = 'M' + x(0).toFixed(1) + ' ' + Y(HV[0]);
  for (let i = 1; i < n; i++) p += 'L' + x(i).toFixed(1) + ' ' + Y(HV[i - 1]) + 'L' + x(i).toFixed(1) + ' ' + Y(HV[i]);
  $('vtrace').innerHTML =
      '<path class="ar" d="' + p + 'L' + x(n - 1).toFixed(1) + ' ' + h + 'L' + x(0).toFixed(1) + ' ' + h + 'Z"/>'
    + '<path class="ln" d="' + p + '"/>';
}

function render(d) {
  document.body.dataset.s = d.status;
  armed = d.armed !== false;
  let t, s;
  if (d.status === 'danger') {
    const g = d.reasons.some(r => r.indexOf('Gas') === 0);
    t = g && d.vibration ? 'Gas and vibration' : g ? 'Gas alarm' : 'Vibration';
    s = d.reasons.join('. ') + '.' + (d.buzzer_on && !d.muted ? ' Buzzer sounding.' : '');
  } else if (d.status === 'warmup') {
    t = 'Warming up'; s = 'Gas alarms are off for ' + fmt(d.warmup_left) + ' while the MQ-2 heats up.';
  } else { t = TXT[d.status][0]; s = TXT[d.status][1]; }
  $('verdict').textContent = t; $('sub').textContent = s;
  $('muteBtn').hidden = !(d.buzzer_on && !d.muted);

  $('armBtn').disabled = false;
  $('armBtn').textContent = armed ? 'Disarm' : 'Arm system';
  $('armBtn').classList.toggle('fill', !armed);
  $('armChip').classList.toggle('on', armed); $('armChip').textContent = armed ? 'Armed' : 'Disarmed';

  $('gasVal').textContent = d.gas === null ? '--' : d.gas;
  $('gasFill').style.width = (d.gas === null ? 0 : d.gas / 1023 * 100) + '%';
  $('gasTick').style.left = 'calc(' + d.threshold / 1023 * 100 + '% - 1px)';
  $('tickVal').textContent = d.threshold;
  $('gasVolt').textContent = d.gas_voltage === null ? '--' : d.gas_voltage;
  if ($('gasSrc')) {
    $('gasSrc').textContent = d.gas_source === 'esp32' ? 'ESP32' + (d.esp32_ip ? ' (' + d.esp32_ip + ')' : '') : d.gas_source === 'simulated' ? 'simulated' : 'no ESP32 data';
    $('gasRaw').textContent = d.gas_raw == null ? '--' : d.gas_raw;
    $('cleanAir').textContent = d.esp32_calibrating ? 'calibrating (30 s), keep the sensor in clean air...'
      : d.clean_air == null ? 'not calibrated (type C in the ESP32 serial monitor)' : d.clean_air + ' of 1023 (raw ' + d.clean_air_raw + ' of 4095)';
  }

  $('vibDot').classList.toggle('on', d.vibration);
  $('vibState').textContent = d.vibration ? 'Vibration detected' : 'No vibration';
  $('vibLast').textContent = d.last_vib ? ago(d.ts - d.last_vib) : 'none since the app started';

  $('bzChip').classList.toggle('on', d.buzzer_on); $('bzChip').textContent = 'Buzzer ' + (d.buzzer_on ? (d.muted ? 'muted' : 'on') : 'off');
  $('ledChip').classList.toggle('on', d.led_on); $('ledChip').textContent = 'LED ' + (d.led_on ? 'on' : 'off');
  $('errors').hidden = d.errors.length === 0; list($('errorList'), d.errors);

  for (const q of d.series) { if (q.gas !== null) H.push({ g: q.gas }); HV.push(q.vib); since = Math.max(since, q.t); }
  while (H.length > 240) H.shift();
  while (HV.length > 240) HV.shift();
  drawTrace(d.threshold);
  drawVib();
}

async function poll() {
  if (busy) return; busy = true;
  try {
    const r = await fetch('/data?since=' + since, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    render(await r.json());
  } catch (e) {
    document.body.dataset.s = 'error';
    $('verdict').textContent = 'No connection';
    $('sub').textContent = 'Cannot reach the Raspberry Pi. Check that app.py is running and that you are on the same network.';
  } finally { busy = false; }
}

async function control(action) {
  try { await fetch('/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }); }
  catch (e) { alert('Cannot reach the Raspberry Pi.'); }
  poll();
}
$('muteBtn').onclick = () => control('mute');
$('armBtn').onclick = () => { $('armBtn').disabled = true; control(armed ? 'disarm' : 'arm'); };
poll(); setInterval(poll, 1000);
</script>`);

/* ======================================================== templates/history.html */
once('templates/history.html',
`    <p class="muted" id="empty" hidden>No data in this range yet. Leave the dashboard app running to collect readings.</p>
  </section>
`,
`    <p class="muted" id="empty" hidden>No data in this range yet. Leave the dashboard app running to collect readings.</p>
  </section>

  <section class="card">
    <span class="lbl">Vibration trend</span>
    <svg class="trace" id="vtrace" viewBox="0 0 720 160" preserveAspectRatio="none" role="img" aria-label="Historical vibration trend" style="height:180px"></svg>
    <div class="axis"><span id="vt0"></span><span>Bar height: share of readings with vibration (short events are drawn at a minimum height so they stay visible)</span><span id="vt1"></span></div>
  </section>
`);

once('templates/history.html',
`async function load() {`,
String.raw`function drawVib(pts) {
  const w = 720, h = 160, el = $('vtrace');
  if (!pts.length) { el.innerHTML = ''; $('vt0').textContent = ''; $('vt1').textContent = ''; return; }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, span = Math.max(1, t1 - t0), bw = Math.max(2, w / pts.length);
  let b = '';
  pts.forEach(q => {
    if (!q.vib) return;
    const bh = Math.max(24, (q.vib_pct == null ? 100 : q.vib_pct) / 100 * h);
    b += '<rect class="vb" style="opacity:.75" x="' + ((q.t - t0) / span * w).toFixed(1) + '" y="' + (h - bh).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '"/>';
  });
  el.innerHTML = b + '<line class="th" x1="0" x2="' + w + '" y1="' + (h - 1) + '" y2="' + (h - 1) + '" style="stroke-dasharray:none"/>';
  const label = t => span > 86400 ? new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : new Date(t * 1000).toLocaleTimeString();
  $('vt0').textContent = label(t0); $('vt1').textContent = label(t1);
}

async function load() {`);

once('templates/history.html',
`    draw(d.chart, d.threshold);
`,
`    draw(d.chart, d.threshold);
    drawVib(d.chart);
`);

/* ================================================================== write */
for (const [rel, e] of out) {
  const text = e.crlf ? e.text.replace(/\n/g, '\r\n') : e.text;
  if (DRY) console.log('[dry-run] would patch', rel);
  else { fs.writeFileSync(path.join(ROOT, rel), text); console.log('patched', rel); }
}
console.log(DRY ? '\nDry run OK: all anchors matched.' : '\nDone. Restart the app:  python app.py   (then hard-refresh the browser: Ctrl+Shift+R)');
