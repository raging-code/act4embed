#!/usr/bin/env node
/*
 * Settings-tab patch for act4embed. Run it AFTER patch-ambient.mjs.
 *
 *   node patch-settings.mjs [projectDir]            apply
 *   node patch-settings.mjs [projectDir] --dry-run  check everything, write nothing
 *   node patch-settings.mjs [projectDir] --revert   undo this patch
 *   node patch-settings.mjs [projectDir] --force    re-apply the pages over a patched project
 *
 * What it does
 *   - adds a Settings page (/settings) holding the threshold, buzzer, LED, alarm and
 *     simulation controls, plus email inputs (sender, app password, recipient, SMTP server)
 *   - slims the Live page down to readings, the graph and the last alert
 *   - adds a Settings link to the History page
 *   - patches app.py: /settings, GET/POST /api/email, and saved email settings
 *
 * Every anchor is checked before anything is written. Backups are saved as
 * *.pre-settings.bak. If the patched app.py fails a Python syntax check, the
 * script restores everything automatically.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const root = resolve(args.find((a) => !a.startsWith('--')) || '.');
const p = (rel) => join(root, rel);
const BAK = '.pre-settings.bak';
const TOUCHED = ['app.py', 'static/style.css', 'templates/index.html', 'templates/history.html'];
const NEW_FILE = 'templates/settings.html';
const CSS_MARK = '/* ambient-settings */';
const PY_MARK = '# ambient-settings';
const fail = (m) => { console.error(m); process.exit(1); };

// ------------------------------------------------------------------ revert
if (flag('--revert')) {
  for (const f of TOUCHED) {
    if (existsSync(p(f) + BAK)) { copyFileSync(p(f) + BAK, p(f)); console.log('restored  ' + f); }
    else console.log('no backup ' + f);
  }
  if (existsSync(p(NEW_FILE))) { unlinkSync(p(NEW_FILE)); console.log('removed   ' + NEW_FILE); }
  process.exit(0);
}

// ------------------------------------------------------------------ preflight
const missing = TOUCHED.filter((f) => !existsSync(p(f)));
if (missing.length) fail('This does not look like the act4embed folder. Missing: ' + missing.join(', '));

const css = readFileSync(p('static/style.css'), 'utf8');
if (!css.includes('/* ambient-theme */')) fail('Run patch-ambient.mjs first (the Ambient theme is not applied yet).');

let py = readFileSync(p('app.py'), 'utf8');
let hist = readFileSync(p('templates/history.html'), 'utf8');
const eol = py.includes('\r\n') ? '\r\n' : '\n';
const nl = (s) => s.replace(/\r?\n/g, eol);

const pyDone = py.includes(PY_MARK);
const A1 = 'settings = load_settings()';
const A2 = 'def local_ip():';
if (!pyDone) {
  if (py.split(A1).length !== 2) fail('app.py: could not find the line "' + A1 + '" exactly once. app.py was edited; nothing was changed.');
  if (py.split(A2).length !== 2) fail('app.py: could not find "' + A2 + '" exactly once. app.py was edited; nothing was changed.');
}
const histDone = hist.includes('href="/settings"');
const HNAV = '<a href="/history" aria-current="page">History</a></nav>';
if (!histDone && !hist.includes(HNAV)) fail('history.html: navigation not found (was it edited after patch-ambient?). Nothing was changed.');
if (pyDone && css.includes(CSS_MARK) && !flag('--force')) { console.log('Already patched. Use --force to re-apply the pages, or --revert to undo.'); process.exit(0); }

// ------------------------------------------------------------------ app.py additions
const PY_STATE = String.raw`
${PY_MARK}: email settings that can be edited from the Settings page
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


load_email_settings()`;

const PY_ROUTES = String.raw`@app.route("/settings")
def settings_page():
    return render_template("settings.html", sim=SIMULATION)


@app.get("/api/email")
def api_email_get():
    def shown(v):
        return "" if v in PLACEHOLDER_EMAILS else v
    return jsonify(enabled=bool(config.EMAIL_ENABLED), user=shown(config.SMTP_USER),
                   to=shown(config.EMAIL_TO), host=config.SMTP_HOST, port=config.SMTP_PORT,
                   has_password=bool(config.SMTP_PASSWORD))


@app.post("/api/email")
def api_email_set():
    d = request.get_json(silent=True) or {}
    enabled = bool(d.get("enabled"))
    user, to = str(d.get("user") or "").strip(), str(d.get("to") or "").strip()
    host = str(d.get("host") or "").strip() or config.SMTP_HOST
    password = str(d.get("password") or "")
    try:
        port = int(d.get("port") or config.SMTP_PORT)
    except (TypeError, ValueError):
        return jsonify(ok=False, error="The SMTP port must be a number"), 400
    if not 1 <= port <= 65535:
        return jsonify(ok=False, error="The SMTP port must be between 1 and 65535"), 400
    ok_mail = lambda s: bool(_re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", s))
    if user and not ok_mail(user):
        return jsonify(ok=False, error="Enter a valid address to send alerts from"), 400
    if to and not ok_mail(to):
        return jsonify(ok=False, error="Enter a valid address to send alerts to"), 400
    if enabled and not (user and to):
        return jsonify(ok=False, error="Enter both email addresses to turn email alerts on"), 400
    if enabled and not (password or config.SMTP_PASSWORD):
        return jsonify(ok=False, error="Enter the app password to turn email alerts on"), 400
    with lock:
        email_file.update(enabled=enabled, user=user, to=to, host=host, port=port)
        if password:
            email_file["password"] = password
        apply_email()
        state["email_enabled"] = config.EMAIL_ENABLED
        state["email_status"] = "Email alerts are on" if enabled else "Email alerts are off"
    save_email_settings()
    return jsonify(ok=True)`;

// ------------------------------------------------------------------ CSS additions
const CSS_ADD = String.raw`
${CSS_MARK}
.stack{display:grid;gap:20px}
.form{max-width:560px}
.field{display:grid;gap:6px;margin:0 0 18px}
.field label{margin:0}
.field input{width:100%;font:inherit;padding:11px 14px;border-radius:12px;border:1px solid var(--edge);background:rgba(0,0,0,.22);color:inherit}
.field input::placeholder{color:inherit;opacity:.5}
.field .hint,.hint{font-size:.92rem;opacity:.7}
.check{display:flex;align-items:center;gap:12px;font-weight:600;cursor:pointer;margin:0 0 20px}
.check input{width:22px;height:22px;accent-color:var(--ink)}
details{margin:0 0 20px}
summary{cursor:pointer;font-weight:600;padding:4px 0}
details .field{margin-top:14px}
.msg{min-height:1.5em;margin:14px 0 0;font-weight:600}
`;

// ------------------------------------------------------------------ pages
const head = (title) => String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&family=Figtree:wght@400;600&display=swap">
<link rel="stylesheet" href="{{ url_for('static', filename='style.css') }}">
</head>`;
const header = (cur) => String.raw`<header>
  <span class="brand">Gas & Vibration Monitor</span>
  <nav aria-label="Pages"><a href="/"${cur === 'live' ? ' aria-current="page"' : ''}>Live</a><a href="/history">History</a><a href="/settings"${cur === 'settings' ? ' aria-current="page"' : ''}>Settings</a></nav>
  {% if sim %}<span class="demo">Simulation mode</span>{% endif %}
</header>`;

const INDEX = head('Gas & Vibration Monitor') + '\n' + String.raw`<body data-s="warmup">
` + header('live') + String.raw`
<main>
  {% if sim %}<div class="banner">Simulation mode: the numbers are fake. Use the test buttons in Settings.</div>{% endif %}
  <div id="errors" class="banner" hidden role="alert"><span>Sensor problem</span><ul id="errorList"></ul></div>

  <section aria-live="polite">
    <h1 class="verdict" id="verdict">Connecting</h1>
    <p class="sub" id="sub">Waiting for the Raspberry Pi.</p>
    <div class="row"><button class="btn fill" id="muteBtn" hidden>Mute alarm</button></div>
  </section>

  <section class="row2">
    <div class="card">
      <span class="lbl">Gas level (MQ-2)</span>
      <div class="num"><span id="gasVal">--</span><small>of 1023</small></div>
      <div class="bar" aria-hidden="true"><i id="gasFill" style="width:0"></i><b id="gasTick"></b></div>
      <div class="bar-note"><span>0</span><span>Alarm at <b id="tickVal">--</b></span><span>1023</span></div>
      <p class="muted">Sensor voltage: <span id="gasVolt">--</span> V</p>
      <div class="chips"><span class="chip" id="vibChip">No vibration</span><span class="chip" id="bzChip">Buzzer off</span><span class="chip" id="ledChip">LED off</span></div>
    </div>
    <div class="card">
      <span class="lbl">Last 2 minutes</span>
      <svg class="trace" id="trace" viewBox="0 0 720 230" preserveAspectRatio="none" role="img" aria-label="Live gas trace"></svg>
    </div>
  </section>

  <section class="card">
    <span class="lbl">Last alert</span>
    <div id="lastAlert">None since the app started</div>
    <p class="muted" id="emailStatus"></p>
    <div class="row"><a class="btn" href="/settings">Alarm and email settings</a></div>
  </section>
</main>

<script>
const $ = id => document.getElementById(id);
const H = [];
let since = 0, busy = false;
const TXT = {
  safe: ['All clear', 'Gas and vibration are both normal.'],
  warning: ['Gas is rising', 'The level is close to the alarm threshold.'],
  error: ['Sensor problem', 'A sensor is not responding. See the message above.']
};
const fmt = sec => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
function list(ul, items) { ul.replaceChildren(...items.map(t => { const li = document.createElement('li'); li.textContent = t; return li; })); }

function drawTrace(thr) {
  const w = 720, h = 230, n = H.length;
  if (!n) return;
  const x = i => (i + 240 - n) / 239 * w, y = g => h - g / 1023 * h;
  let p = '', b = '';
  H.forEach((q, i) => {
    p += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(q.g).toFixed(1);
    if (q.v) b += '<rect class="vb" x="' + x(i).toFixed(1) + '" y="0" width="' + (w / 239 + .5).toFixed(1) + '" height="' + h + '"/>';
  });
  $('trace').innerHTML = b
    + '<path class="ar" d="' + p + 'L' + w + ' ' + h + 'L' + x(0).toFixed(1) + ' ' + h + 'Z"/>'
    + '<line class="th" x1="0" x2="' + w + '" y1="' + y(thr) + '" y2="' + y(thr) + '"/>'
    + '<path class="ln" d="' + p + '"/>';
}

function render(d) {
  document.body.dataset.s = d.status;
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

  $('gasVal').textContent = d.gas === null ? '--' : d.gas;
  $('gasFill').style.width = (d.gas === null ? 0 : d.gas / 1023 * 100) + '%';
  $('gasTick').style.left = 'calc(' + d.threshold / 1023 * 100 + '% - 1px)';
  $('tickVal').textContent = d.threshold;
  $('gasVolt').textContent = d.gas_voltage === null ? '--' : d.gas_voltage;

  $('vibChip').classList.toggle('on', d.vibration); $('vibChip').textContent = d.vibration ? 'Vibration detected' : 'No vibration';
  $('bzChip').classList.toggle('on', d.buzzer_on); $('bzChip').textContent = 'Buzzer ' + (d.buzzer_on ? (d.muted ? 'muted' : 'on') : 'off');
  $('ledChip').classList.toggle('on', d.led_on); $('ledChip').textContent = 'LED ' + (d.led_on ? 'on' : 'off');
  $('errors').hidden = d.errors.length === 0; list($('errorList'), d.errors);

  $('lastAlert').textContent = d.last_alert ? new Date(d.last_alert.ts * 1000).toLocaleTimeString() + ' - ' + d.last_alert.kind + ': ' + d.last_alert.message : 'None since the app started';
  $('emailStatus').textContent = d.email_status + (d.last_email ? ' (' + new Date(d.last_email * 1000).toLocaleTimeString() + ')' : '');

  for (const q of d.series) { if (q.gas !== null) H.push({ g: q.gas, v: q.vib }); since = Math.max(since, q.t); }
  while (H.length > 240) H.shift();
  drawTrace(d.threshold);
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

$('muteBtn').onclick = async () => {
  try { await fetch('/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'mute' }) }); }
  catch (e) { alert('Cannot reach the Raspberry Pi.'); }
  poll();
};
poll(); setInterval(poll, 1000);
</script>
</body>
</html>
`;

const SETTINGS = head('Settings - Gas & Vibration Monitor') + '\n' + String.raw`<body data-s="safe">
` + header('settings') + String.raw`
<main>
  {% if sim %}<div class="banner">Simulation mode: the sensor data is fake.</div>{% endif %}
  <section>
    <h1 class="verdict sm">Settings</h1>
    <p class="sub">Alarm behaviour, email alerts and tests.</p>
  </section>

  <section class="card dock" aria-label="Alarm settings">
    <div>
      <label for="thrRange">Gas alarm threshold</label>
      <input id="thrRange" type="range" min="1" max="1023" step="1" value="400">
      <div class="row"><input id="thrNum" type="number" min="1" max="1023" aria-label="Threshold value"></div>
      <div class="row"><button class="btn" id="thrSave">Save threshold</button></div>
    </div>
    <div>
      <span class="lbl">Buzzer</span>
      <div class="seg"><button data-a="buzzer" data-v="auto">Auto</button><button data-a="buzzer" data-v="on">On</button><button data-a="buzzer" data-v="off">Off</button></div>
      <span class="lbl" style="margin-top:16px">LED</span>
      <div class="seg"><button data-a="led" data-v="auto">Auto</button><button data-a="led" data-v="on">On</button><button data-a="led" data-v="off">Off</button></div>
    </div>
    <div>
      <span class="lbl">Alarm</span>
      <div class="row" style="margin-top:0"><button class="btn fill" id="muteBtn">Mute alarm</button></div>
      <div class="row"><button class="btn" id="resetBtn">Reset to auto</button></div>
      <p class="muted" id="mutedNote" hidden>Buzzer muted until the alarm ends.</p>
      <p class="muted">Auto: the buzzer sounds on gas over the threshold or vibration; the LED lights on vibration.</p>
    </div>
    {% if sim %}
    <div>
      <span class="lbl">Simulation tests</span>
      <div class="row" style="margin-top:0"><button class="btn" id="simGas">Simulate gas leak (10 s)</button></div>
      <div class="row"><button class="btn" id="simVib">Simulate vibration</button></div>
    </div>
    {% endif %}
  </section>

  <section class="card" id="email">
    <h2>Email alerts</h2>
    <form id="emailForm" class="form">
      <label class="check"><input type="checkbox" id="emEnabled"> Send an email when an alarm starts</label>
      <div class="field"><label for="emUser">Send alerts from</label><input id="emUser" type="email" autocomplete="email" placeholder="you@gmail.com"></div>
      <div class="field"><label for="emPass">App password</label><input id="emPass" type="password" autocomplete="new-password" placeholder="App password">
        <span class="hint" id="pwHint">Gmail needs an app password, not your normal password: Google Account, Security, 2-Step Verification, App passwords.</span></div>
      <div class="field"><label for="emTo">Send alerts to</label><input id="emTo" type="email" autocomplete="off" placeholder="name@example.com"></div>
      <details>
        <summary>SMTP server</summary>
        <div class="field"><label for="emHost">Server</label><input id="emHost" type="text" autocomplete="off" placeholder="smtp.gmail.com"></div>
        <div class="field"><label for="emPort">Port (587 for STARTTLS, 465 for SSL)</label><input id="emPort" type="number" min="1" max="65535" placeholder="587"></div>
      </details>
      <div class="row"><button class="btn fill" type="submit">Save email settings</button><button class="btn" type="button" id="testEmail">Send test email</button></div>
      <p class="msg" id="emMsg" role="status"></p>
      <p class="muted" id="emailStatus"></p>
      <p class="hint">At most one alert email is sent every 5 minutes.</p>
    </form>
  </section>
</main>

<script>
const $ = id => document.getElementById(id);
let busy = false;

async function send(action, value) {
  try {
    const r = await fetch('/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, value }) });
    const j = await r.json(); if (!j.ok) alert(j.error || 'Command failed');
  } catch (e) { alert('Cannot reach the Raspberry Pi.'); }
  poll();
}

function sync(d) {
  document.body.dataset.s = d.status;
  document.querySelectorAll('[data-a=buzzer]').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === d.buzzer_mode));
  document.querySelectorAll('[data-a=led]').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === d.led_mode));
  $('mutedNote').hidden = !d.muted;
  if (document.activeElement !== $('thrRange') && document.activeElement !== $('thrNum')) { $('thrRange').value = d.threshold; $('thrNum').value = d.threshold; }
  $('emailStatus').textContent = d.email_status + (d.last_email ? ' (' + new Date(d.last_email * 1000).toLocaleTimeString() + ')' : '');
}

async function poll() {
  if (busy) return; busy = true;
  try {
    const r = await fetch('/data?since=1e18', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    sync(await r.json());
  } catch (e) { document.body.dataset.s = 'error'; $('emailStatus').textContent = 'Cannot reach the Raspberry Pi.'; }
  finally { busy = false; }
}

async function loadEmail() {
  try {
    const d = await (await fetch('/api/email', { cache: 'no-store' })).json();
    $('emEnabled').checked = d.enabled; $('emUser').value = d.user; $('emTo').value = d.to;
    $('emHost').value = d.host; $('emPort').value = d.port;
    $('emPass').placeholder = d.has_password ? 'Saved. Leave blank to keep it.' : 'App password';
  } catch (e) { $('emMsg').textContent = 'Cannot load email settings.'; }
}

async function saveEmail() {
  const body = { enabled: $('emEnabled').checked, user: $('emUser').value.trim(), password: $('emPass').value,
                 to: $('emTo').value.trim(), host: $('emHost').value.trim(), port: $('emPort').value };
  try {
    const r = await fetch('/api/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    $('emMsg').textContent = j.ok ? 'Saved.' : (j.error || 'Could not save.');
    if (j.ok) { $('emPass').value = ''; await loadEmail(); poll(); }
    return !!j.ok;
  } catch (e) { $('emMsg').textContent = 'Cannot reach the Raspberry Pi.'; return false; }
}

document.querySelectorAll('[data-a]').forEach(b => b.onclick = () => send(b.dataset.a, b.dataset.v));
$('muteBtn').onclick = () => send('mute'); $('resetBtn').onclick = () => send('reset');
$('thrRange').oninput = () => $('thrNum').value = $('thrRange').value;
$('thrNum').oninput = () => $('thrRange').value = $('thrNum').value;
$('thrRange').onchange = () => send('threshold', $('thrRange').value);
$('thrSave').onclick = () => send('threshold', $('thrNum').value);
$('emailForm').onsubmit = e => { e.preventDefault(); saveEmail(); };
$('testEmail').onclick = async () => { if (await saveEmail()) { $('emMsg').textContent = 'Saved. Sending a test email...'; send('test_email'); } };
if ($('simGas')) { $('simGas').onclick = () => send('sim_gas'); $('simVib').onclick = () => send('sim_vibration'); }

loadEmail(); poll(); setInterval(poll, 1000);
</script>
</body>
</html>
`;

// ------------------------------------------------------------------ build outputs in memory
if (!pyDone) {
  py = py.replace(A1, () => A1 + eol + nl(PY_STATE));
  py = py.replace(A2, () => nl(PY_ROUTES) + eol + eol + eol + A2);
  py = py.replace('"Set EMAIL_ENABLED = True in config.py"', '"Turn on email alerts in Settings first"');
}
if (!histDone) hist = hist.replace(HNAV, '<a href="/history" aria-current="page">History</a><a href="/settings">Settings</a></nav>');
const newCss = css.includes(CSS_MARK) ? css : css.replace(/\s*$/, '\n') + CSS_ADD;

const OUT = {
  'app.py': py, 'static/style.css': newCss, 'templates/index.html': INDEX,
  'templates/history.html': hist, [NEW_FILE]: SETTINGS,
};

if (flag('--dry-run')) {
  for (const f of Object.keys(OUT)) console.log('would write ' + f);
  console.log('All anchors found. Nothing was changed.');
  process.exit(0);
}

// ------------------------------------------------------------------ write, then verify app.py
for (const f of TOUCHED) if (!existsSync(p(f) + BAK)) copyFileSync(p(f), p(f) + BAK);
for (const [f, text] of Object.entries(OUT)) { writeFileSync(p(f), text); console.log('patched   ' + f); }

const check = "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read())";
let checked = false;
for (const exe of ['python3', 'python', 'py']) {
  const r = spawnSync(exe, ['-c', check, p('app.py')], { encoding: 'utf8' });
  if (r.error) continue;
  checked = true;
  if (r.status !== 0) {
    console.error('\napp.py failed the Python syntax check, so everything was restored:\n' + r.stderr);
    for (const f of TOUCHED) copyFileSync(p(f) + BAK, p(f));
    if (existsSync(p(NEW_FILE))) unlinkSync(p(NEW_FILE));
    process.exit(1);
  }
  break;
}
console.log(checked ? '\napp.py syntax check passed.' : '\n(Python not found, so app.py was not syntax-checked.)');
console.log('Backups: *' + BAK + '  (undo with: node patch-settings.mjs --revert)');
console.log('Restart the app (Ctrl+C, then python app.py) and hard-refresh the browser. Settings is at /settings.');
