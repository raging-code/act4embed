#!/usr/bin/env node
/*
 * Ambient redesign patch for act4embed (Gas & Vibration Monitor)
 *
 *   node patch-ambient.mjs [projectDir]            apply the patch
 *   node patch-ambient.mjs [projectDir] --dry-run  show what would change
 *   node patch-ambient.mjs [projectDir] --revert   restore the .bak files
 *   node patch-ambient.mjs [projectDir] --force    re-apply over an already patched project
 *
 * Rewrites static/style.css, templates/index.html and templates/history.html.
 * Originals are saved next to them as *.bak. app.py is not touched: the /data,
 * /control, /api/history and /export.csv endpoints keep working as before.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const root = resolve(args.find((a) => !a.startsWith('--')) || '.');
const FILES = ['static/style.css', 'templates/index.html', 'templates/history.html'];
const MARKER = '/* ambient-theme */';
const p = (rel) => join(root, rel);

const missing = ['app.py', ...FILES].filter((f) => !existsSync(p(f)));
if (missing.length) {
  console.error('This does not look like the act4embed project folder. Missing: ' + missing.join(', '));
  console.error('Run the script from the project folder, or pass the folder: node patch-ambient.mjs path/to/act4embed');
  process.exit(1);
}

if (flag('--revert')) {
  for (const f of FILES) {
    if (existsSync(p(f) + '.bak')) { copyFileSync(p(f) + '.bak', p(f)); console.log('restored  ' + f); }
    else console.log('no backup ' + f);
  }
  process.exit(0);
}

if (readFileSync(p('static/style.css'), 'utf8').startsWith(MARKER) && !flag('--force')) {
  console.log('Already patched. Use --force to apply again, or --revert to go back.');
  process.exit(0);
}

// ---------------------------------------------------------------- style.css
const STYLE = String.raw`/* ambient-theme */
:root{box-sizing:border-box;--bg:#0d3b3a;--ink:#e8fff3;--glass:rgba(255,255,255,.08);--edge:rgba(255,255,255,.18)}
*,*::before,*::after{box-sizing:inherit}
body[data-s=warning]{--bg:#5c3a04;--ink:#fff3d6}
body[data-s=danger]{--bg:#b3121b;--ink:#fff}
body[data-s=warmup]{--bg:#23384a;--ink:#e6f1fb}
body[data-s=error]{--bg:#3f2a5a;--ink:#f1e8ff}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:400 1rem/1.5 Figtree,"Segoe UI",system-ui,sans-serif;transition:background .8s,color .8s}
body[data-s=danger]{animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{50%{background:#8f0d15}}
:focus-visible{outline:3px solid var(--ink);outline-offset:3px}
[hidden]{display:none!important}
header{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;padding:20px clamp(18px,5vw,56px)}
.brand{font:800 1.05rem "Bricolage Grotesque",system-ui,sans-serif;margin-right:auto}
nav{display:flex;gap:4px}
nav a{color:inherit;text-decoration:none;padding:6px 14px;border-radius:99px;opacity:.7}
nav a[aria-current]{opacity:1;background:var(--glass)}
.demo{font-size:.85rem;opacity:.75}
main{max-width:1240px;margin:0 auto;padding:clamp(12px,4vw,48px) clamp(18px,5vw,56px) 56px;display:grid;gap:28px}
.verdict{font:800 clamp(3.2rem,13vw,10rem)/.9 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.045em;margin:0;text-wrap:balance}
.verdict.sm{font-size:clamp(2.6rem,8vw,5.5rem)}
.sub{font-size:1.2rem;max-width:52ch;opacity:.85;margin:16px 0 0}
.banner{padding:12px 18px;border-radius:16px;border:1px solid var(--edge);background:var(--glass);font-weight:600}
.banner ul{margin:6px 0 0;padding-left:20px;font-weight:400}
.row2{display:grid;grid-template-columns:minmax(260px,1fr) 2fr;gap:20px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.card{background:var(--glass);border:1px solid var(--edge);border-radius:28px;padding:26px;min-width:0}
.lbl,label{display:block;font-weight:600;opacity:.85;margin:0 0 10px}
.num{font:800 clamp(4rem,9vw,6.5rem)/1 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.num small{font:600 1rem Figtree,system-ui,sans-serif;opacity:.7;margin-left:8px;letter-spacing:0}
.bar{position:relative;height:14px;border-radius:9px;background:rgba(255,255,255,.14);margin:24px 0 10px}
.bar i{display:block;height:100%;border-radius:9px;background:var(--ink);transition:width .4s}
.bar b{position:absolute;top:-8px;width:3px;height:30px;border-radius:2px;background:var(--ink)}
.bar-note{display:flex;justify-content:space-between;font-size:.9rem;opacity:.8}
.muted{opacity:.75;font-size:.92rem;margin:10px 0 0}
.chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.chip{padding:6px 14px;border-radius:99px;border:1px solid var(--edge);font-weight:600}
.chip.on{background:var(--ink);color:var(--bg)}
svg.trace{width:100%;height:230px;display:block;margin-top:6px}
.ln{fill:none;stroke:var(--ink);stroke-width:2.5;vector-effect:non-scaling-stroke}
.ar{fill:var(--ink);opacity:.09}
.th{stroke:var(--ink);stroke-dasharray:6 6;opacity:.6;vector-effect:non-scaling-stroke}
.vb{fill:var(--ink);opacity:.2}
.axis{display:flex;justify-content:space-between;font-size:.88rem;opacity:.75;margin-top:8px}
.dock{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:24px;align-items:start}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:12px}
.seg{display:inline-flex;padding:4px;border-radius:99px;background:rgba(0,0,0,.22)}
.seg button{border:0;background:none;color:inherit;font:600 .95rem Figtree,system-ui,sans-serif;padding:9px 18px;border-radius:99px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--ink);color:var(--bg)}
input[type=range]{width:100%;accent-color:var(--ink)}
input[type=number],input[type=datetime-local],select{font:inherit;padding:9px 12px;border-radius:12px;border:1px solid var(--edge);background:rgba(0,0,0,.22);color:inherit;color-scheme:dark}
input[type=number]{width:104px}
.btn,a.btn{display:inline-block;text-decoration:none;font:600 1rem Figtree,system-ui,sans-serif;padding:11px 22px;border-radius:99px;border:1px solid var(--edge);background:none;color:inherit;cursor:pointer}
.btn.fill{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.filters{display:flex;flex-wrap:wrap;gap:16px 20px;align-items:end}
.filters .row{margin:0}
.stats{display:flex;flex-wrap:wrap;gap:14px 44px}
.stats b{display:block;font:800 2.3rem/1.1 "Bricolage Grotesque",system-ui,sans-serif;font-variant-numeric:tabular-nums}
.stats span{opacity:.75}
.scroll{max-height:340px;overflow:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--edge);font-size:.94rem}
th{position:sticky;top:0;background:var(--bg);font-weight:600}
h2{font-size:1rem;font-weight:600;opacity:.85;margin:0 0 12px}
@media(max-width:800px){.row2,.two{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}body[data-s=danger]{animation:none}}
`;

// ---------------------------------------------------------------- shared head/header
const head = (title) => String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&family=Figtree:wght@400;600&display=swap">
<link rel="stylesheet" href="{{ url_for('static', filename='style.css') }}">
</head>`;
const header = (live) => String.raw`<header>
  <span class="brand">Gas & Vibration Monitor</span>
  <nav aria-label="Pages"><a href="/"${live ? ' aria-current="page"' : ''}>Live</a><a href="/history"${live ? '' : ' aria-current="page"'}>History</a></nav>
  {% if sim %}<span class="demo">Simulation mode</span>{% endif %}
</header>`;

// ---------------------------------------------------------------- index.html
const INDEX = head('Gas & Vibration Monitor') + '\n' + String.raw`<body data-s="warmup">
` + header(true) + String.raw`
<main>
  {% if sim %}<div class="banner">Simulation mode: the numbers are fake. Use the test buttons below.</div>{% endif %}
  <div id="errors" class="banner" hidden role="alert"><span>Sensor problem</span><ul id="errorList"></ul></div>

  <section aria-live="polite">
    <h1 class="verdict" id="verdict">Connecting</h1>
    <p class="sub" id="sub">Waiting for the Raspberry Pi.</p>
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

  <section class="card dock">
    <div>
      <label for="thrRange">Gas alarm threshold</label>
      <input id="thrRange" type="range" min="1" max="1023" step="1" value="400">
      <div class="row"><input id="thrNum" type="number" min="1" max="1023" aria-label="Threshold value"><button class="btn" id="thrSave">Save threshold</button></div>
    </div>
    <div>
      <span class="lbl">Buzzer</span>
      <div class="seg"><button data-a="buzzer" data-v="auto">Auto</button><button data-a="buzzer" data-v="on">On</button><button data-a="buzzer" data-v="off">Off</button></div>
      <span class="lbl" style="margin-top:16px">LED</span>
      <div class="seg"><button data-a="led" data-v="auto">Auto</button><button data-a="led" data-v="on">On</button><button data-a="led" data-v="off">Off</button></div>
    </div>
    <div>
      <span class="lbl">Alarm</span>
      <div class="row" style="margin-top:0"><button class="btn fill" id="muteBtn">Mute alarm</button><button class="btn" id="resetBtn">Reset to auto</button></div>
      <p class="muted" id="mutedNote" hidden>Buzzer muted until the alarm ends.</p>
      <p class="muted">Auto: the buzzer sounds on gas over the threshold or vibration; the LED lights on vibration.</p>
    </div>
    {% if sim %}
    <div>
      <span class="lbl">Simulation tests</span>
      <div class="row" style="margin-top:0"><button class="btn" id="simGas">Simulate gas leak (10 s)</button><button class="btn" id="simVib">Simulate vibration</button></div>
    </div>
    {% endif %}
  </section>

  <section class="card">
    <span class="lbl">Last alert</span>
    <div id="lastAlert">None since the app started</div>
    <p class="muted" id="emailStatus"></p>
    <div class="row"><button class="btn" id="testEmail">Send test email</button></div>
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

  $('gasVal').textContent = d.gas === null ? '--' : d.gas;
  $('gasFill').style.width = (d.gas === null ? 0 : d.gas / 1023 * 100) + '%';
  $('gasTick').style.left = 'calc(' + d.threshold / 1023 * 100 + '% - 1px)';
  $('tickVal').textContent = d.threshold;
  $('gasVolt').textContent = d.gas_voltage === null ? '--' : d.gas_voltage;

  $('vibChip').classList.toggle('on', d.vibration); $('vibChip').textContent = d.vibration ? 'Vibration detected' : 'No vibration';
  $('bzChip').classList.toggle('on', d.buzzer_on); $('bzChip').textContent = 'Buzzer ' + (d.buzzer_on ? (d.muted ? 'muted' : 'on') : 'off') + ' (' + d.buzzer_mode + ')';
  $('ledChip').classList.toggle('on', d.led_on); $('ledChip').textContent = 'LED ' + (d.led_on ? 'on' : 'off') + ' (' + d.led_mode + ')';
  $('mutedNote').hidden = !d.muted;
  document.querySelectorAll('[data-a=buzzer]').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === d.buzzer_mode));
  document.querySelectorAll('[data-a=led]').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === d.led_mode));
  $('errors').hidden = d.errors.length === 0; list($('errorList'), d.errors);

  if (document.activeElement !== $('thrRange') && document.activeElement !== $('thrNum')) { $('thrRange').value = d.threshold; $('thrNum').value = d.threshold; }
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

async function send(action, value) {
  try {
    const r = await fetch('/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, value }) });
    const j = await r.json(); if (!j.ok) alert(j.error || 'Command failed');
  } catch (e) { alert('Cannot reach the Raspberry Pi.'); }
  poll();
}

document.querySelectorAll('[data-a]').forEach(b => b.onclick = () => send(b.dataset.a, b.dataset.v));
$('muteBtn').onclick = () => send('mute'); $('resetBtn').onclick = () => send('reset');
$('testEmail').onclick = () => send('test_email');
$('thrRange').oninput = () => $('thrNum').value = $('thrRange').value;
$('thrNum').oninput = () => $('thrRange').value = $('thrNum').value;
$('thrRange').onchange = () => send('threshold', $('thrRange').value);
$('thrSave').onclick = () => send('threshold', $('thrNum').value);
if ($('simGas')) { $('simGas').onclick = () => send('sim_gas'); $('simVib').onclick = () => send('sim_vibration'); }

poll(); setInterval(poll, 1000);
</script>
</body>
</html>
`;

// ---------------------------------------------------------------- history.html
const HISTORY = head('History - Gas & Vibration Monitor') + '\n' + String.raw`<body data-s="safe">
` + header(false) + String.raw`
<main>
  {% if sim %}<div class="banner">Simulation mode: the logged data is fake.</div>{% endif %}
  <section>
    <h1 class="verdict sm">History</h1>
    <p class="sub">Gas readings, vibration and alerts logged by the Raspberry Pi.</p>
  </section>

  <section class="card filters">
    <div><label for="preset">Time range</label>
      <select id="preset">
        <option value="3600">Last hour</option>
        <option value="21600">Last 6 hours</option>
        <option value="86400">Last 24 hours</option>
        <option value="604800">Last 7 days</option>
        <option value="all">All data</option>
        <option value="custom">Custom...</option>
      </select></div>
    <div id="customBox" class="row" hidden>
      <div><label for="from">From</label><input id="from" type="datetime-local"></div>
      <div><label for="to">To</label><input id="to" type="datetime-local"></div>
    </div>
    <div class="row"><button class="btn fill" id="apply">Show</button><a id="csv" class="btn" href="/export.csv?range=3600">Download CSV</a></div>
  </section>

  <section class="card stats">
    <div><b id="sN">--</b><span>readings</span></div>
    <div><b id="sMax">--</b><span>highest gas</span></div>
    <div><b id="sAvg">--</b><span>average gas</span></div>
    <div><b id="sVib">--</b><span>vibration readings</span></div>
    <div><b id="sAlerts">--</b><span>alerts</span></div>
  </section>

  <section class="card">
    <span class="lbl">Gas trend</span>
    <svg class="trace" id="trace" viewBox="0 0 720 260" preserveAspectRatio="none" role="img" aria-label="Historical gas trend" style="height:280px"></svg>
    <div class="axis"><span id="t0"></span><span>Dashed line: alarm threshold. Shaded bands: vibration seen.</span><span id="t1"></span></div>
    <p class="muted" id="empty" hidden>No data in this range yet. Leave the dashboard app running to collect readings.</p>
  </section>

  <section class="two">
    <div class="card"><h2>Alert log</h2>
      <div class="scroll"><table><thead><tr><th>Time</th><th>Type</th><th>Details</th><th>Email</th></tr></thead><tbody id="alerts"></tbody></table></div></div>
    <div class="card"><h2>Latest readings (max 100)</h2>
      <div class="scroll"><table><thead><tr><th>Time</th><th>Gas</th><th>Vibration</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table></div></div>
  </section>
</main>

<script>
const $ = id => document.getElementById(id);
const tm = ts => new Date(ts * 1000).toLocaleString();
function cell(tr, text) { const td = document.createElement('td'); td.textContent = text; tr.appendChild(td); }

function query() {
  const p = $('preset').value;
  if (p !== 'custom') return 'range=' + p;
  const f = $('from').value, t = $('to').value;
  const s = f ? Math.floor(new Date(f) / 1000) : 0, e = t ? Math.floor(new Date(t) / 1000) : Math.floor(Date.now() / 1000) + 60;
  return 'start=' + s + '&end=' + e;
}

function draw(pts, thr) {
  const w = 720, h = 260, el = $('trace');
  if (!pts.length) { el.innerHTML = ''; $('t0').textContent = ''; $('t1').textContent = ''; return; }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, span = Math.max(1, t1 - t0), bw = Math.max(2, w / pts.length);
  const x = t => (t - t0) / span * w, y = g => h - g / 1023 * h;
  let p = '', b = '';
  pts.forEach((q, i) => {
    const X = x(q.t).toFixed(1);
    p += (i ? 'L' : 'M') + X + ' ' + y(q.gas).toFixed(1);
    if (q.vib) b += '<rect class="vb" x="' + X + '" y="0" width="' + bw.toFixed(1) + '" height="' + h + '"/>';
  });
  el.innerHTML = b
    + '<path class="ar" d="' + p + 'L' + x(t1).toFixed(1) + ' ' + h + 'L0 ' + h + 'Z"/>'
    + '<line class="th" x1="0" x2="' + w + '" y1="' + y(thr) + '" y2="' + y(thr) + '"/>'
    + '<path class="ln" d="' + p + '"/>';
  const label = t => span > 86400 ? new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : new Date(t * 1000).toLocaleTimeString();
  $('t0').textContent = label(t0); $('t1').textContent = label(t1);
}

async function load() {
  const q = query();
  $('csv').href = '/export.csv?' + q;
  try {
    const r = await fetch('/api/history?' + q, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    draw(d.chart, d.threshold);
    $('empty').hidden = d.chart.length > 0; $('empty').textContent = 'No data in this range yet. Leave the dashboard app running to collect readings.';
    $('sN').textContent = d.stats.n; $('sMax').textContent = d.stats.max_gas ?? '--';
    $('sAvg').textContent = d.stats.avg_gas ?? '--'; $('sVib').textContent = d.stats.vib_samples ?? 0; $('sAlerts').textContent = d.alerts.length;
    $('alerts').replaceChildren(...d.alerts.map(a => { const tr = document.createElement('tr'); cell(tr, tm(a.ts)); cell(tr, a.kind); cell(tr, a.message); cell(tr, a.email_sent ? 'Sent' : '-'); return tr; }));
    $('rows').replaceChildren(...d.rows.map(x => { const tr = document.createElement('tr'); cell(tr, tm(x.ts)); cell(tr, x.gas); cell(tr, x.vib ? 'Detected' : 'No'); cell(tr, x.status); return tr; }));
  } catch (e) { $('empty').hidden = false; $('empty').textContent = 'Could not load history: ' + e.message; }
}

$('preset').onchange = () => { $('customBox').hidden = $('preset').value !== 'custom'; if ($('preset').value !== 'custom') load(); };
$('apply').onclick = load;
load(); setInterval(() => { if ($('preset').value !== 'custom') load(); }, 15000);
</script>
</body>
</html>
`;

// ---------------------------------------------------------------- apply
const OUT = { 'static/style.css': STYLE, 'templates/index.html': INDEX, 'templates/history.html': HISTORY };

for (const f of FILES) {
  if (flag('--dry-run')) { console.log('would write ' + f + ' (' + OUT[f].length + ' bytes)'); continue; }
  if (!existsSync(p(f) + '.bak')) copyFileSync(p(f), p(f) + '.bak');
  writeFileSync(p(f), OUT[f]);
  console.log('patched   ' + f);
}

if (!flag('--dry-run')) {
  console.log('\nDone. Backups saved as *.bak (undo with: node patch-ambient.mjs --revert).');
  console.log('Restart the app (Ctrl+C, then python app.py) and hard-refresh the browser.');
  console.log('Note: static/chart.umd.js is no longer used and can be deleted.');
}
