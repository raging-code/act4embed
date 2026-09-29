#!/usr/bin/env node
/**
 * patch2.mjs - act4embed, second round of changes. Apply AFTER the first patch.mjs.
 *
 *   - Live tab: gas widget on top, vibration widget below (stacked, full width)
 *   - ONE arm/disarm button: green = armed, red = disarmed (tap to toggle)
 *   - Buzzer / LED indicators removed from the Live tab
 *   - Graphs (Live + History) can be zoomed in/out and scrolled sideways
 *       Live: 1x = 2 minutes across the screen, scroll back up to 1 hour, zoom 0.1x - 20x
 *       History: 1x = whole selected range, zoom up to 40x
 *       Zoom: + / - buttons, or Ctrl (Cmd) + mouse wheel / trackpad pinch
 *       Scroll: drag with the mouse, swipe, shift + wheel, or the scrollbar / arrow keys
 *       The gas and vibration graphs on a page move together.
 *
 * Usage (from the repo root, next to app.py):
 *     node patch2.mjs --dry-run   check only, writes nothing
 *     node patch2.mjs
 * If an anchor doesn't match, NOTHING is written. Undo everything with:  git checkout -- .
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
  const e = { text: raw.replace(/\r\n/g, '\n'), crlf: raw.includes('\r\n') };
  out.set(rel, e);
  return e;
}

function between(rel, start, end, repl) {
  const e = load(rel);
  const i = e.text.indexOf(start);
  if (i < 0) fail(rel + ': start marker not found: ' + start.trim().split('\n')[0]);
  const j = e.text.indexOf(end, i);
  if (j < 0) fail(rel + ': end marker not found: ' + end.trim().split('\n')[0]);
  e.text = e.text.slice(0, i) + repl + e.text.slice(j + end.length);
}

function regexOnce(rel, re, repl) {
  const e = load(rel);
  const m = e.text.match(re);
  if (!m) fail(rel + ': pattern not found: ' + re);
  e.text = e.text.replace(re, () => repl);
}

const idx = load('templates/index.html').text;
if (idx.includes('id="gsc"')) { console.log('Already patched (patch2). Nothing to do.'); process.exit(0); }
if (!idx.includes('id="armBtn"')) fail('Run the first patch first:  node patch.mjs   (then run this one).');

const zbar = (last) =>
  '<div class="zbar"><span class="zlbl">1.0&times;</span>'
  + '<button class="btn zb" data-z="out" aria-label="Zoom out">&minus;</button>'
  + '<button class="btn zb" data-z="in" aria-label="Zoom in">+</button>'
  + '<button class="btn zb" data-z="' + last[0] + '">' + last[1] + '</button></div>';

// the pan / zoom-by-wheel wiring is identical on both pages
const WIRE = String.raw`
SC.forEach((s, i) => {
  s.addEventListener('scroll', () => { const o = SC[1 - i]; if (Math.abs(o.scrollLeft - s.scrollLeft) > 1) o.scrollLeft = s.scrollLeft; onScroll(); });
  s.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return;          // plain wheel keeps scrolling the page
    e.preventDefault();
    const r = s.getBoundingClientRect();
    setZoom(zoom * (e.deltaY < 0 ? 1.25 : 0.8), (e.clientX - r.left) / r.width);
  }, { passive: false });
  let down = null;                                  // mouse drag = pan (touch already swipes natively)
  s.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse' || e.button !== 0) return; down = { x: e.clientX, l: s.scrollLeft }; s.setPointerCapture(e.pointerId); s.classList.add('drag'); });
  s.addEventListener('pointermove', e => { if (down) s.scrollLeft = down.l - (e.clientX - down.x); });
  const end = () => { down = null; s.classList.remove('drag'); };
  s.addEventListener('pointerup', end); s.addEventListener('pointercancel', end);
});
`;

/* ================================================================== config.py */
// the Live page can scroll back through everything the server keeps: 1 hour
regexOnce('config.py', /^GRAPH_POINTS = \d+.*$/m,
  'GRAPH_POINTS = 7200          # points kept for the live graphs (7200 x 0.5s = 1 hour); the Live page shows 2 min at 1x zoom and scrolls back');

/* ================================================================ style.css */
{
  const e = load('static/style.css');
  e.text = e.text.replace(/\s*$/, '\n') + String.raw`
/* ambient-widgets-2: stacked widgets, arm button, zoomable graphs */
.wtop{display:grid;grid-template-columns:minmax(260px,1fr) 1fr;gap:8px 40px;align-items:start}
.btn.arm{color:#fff;border:2px solid #fff;font-weight:800;padding:12px 28px;font-size:1.05rem}
.btn.arm.on{background:#15803d}
.btn.arm.off{background:#b91c1c}
.ghead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.ghead h2,.ghead .lbl{margin:0}
.zbar{display:flex;align-items:center;gap:8px}
.zbar .zb{padding:5px 14px;min-width:46px}
.zlbl{font-size:.9rem;opacity:.75;margin-right:6px;font-variant-numeric:tabular-nums}
.gscroll{overflow-x:auto;overflow-y:hidden;cursor:grab;border-radius:14px;scrollbar-width:thin;overscroll-behavior-x:contain}
.gscroll.drag{cursor:grabbing;user-select:none}
.gscroll svg.trace{margin-top:0}
.grid{stroke:var(--ink);opacity:.14;vector-effect:non-scaling-stroke}
.tk{fill:var(--ink);opacity:.65;font:12px Figtree,system-ui,sans-serif}
@media(max-width:800px){.wtop{grid-template-columns:1fr}}
`;
}

/* ========================================================== templates/index.html */
between('templates/index.html', '  <section aria-live="polite">', '<script>', String.raw`  <section aria-live="polite">
    <h1 class="verdict" id="verdict">Connecting</h1>
    <p class="sub" id="sub">Waiting for the Raspberry Pi.</p>
    <div class="row"><button class="btn arm" id="armBtn" disabled>Arm / Disarm</button><button class="btn fill" id="muteBtn" hidden>Mute alarm</button></div>
  </section>

  <section class="stack">
    <div class="card wgt">
      <span class="lbl">Gas level (MQ-2)</span>
      <div class="wtop">
        <div>
          <div class="num"><span id="gasVal">--</span><small>of 1023</small></div>
          <div class="bar" aria-hidden="true"><i id="gasFill" style="width:0"></i><b id="gasTick"></b></div>
          <div class="bar-note"><span>0</span><span>Alarm at <b id="tickVal">--</b></span><span>1023</span></div>
        </div>
        <div>
          <p class="muted">Sensor voltage: <span id="gasVolt">--</span> V</p>
          <p class="muted">Source: <span id="gasSrc">--</span> &middot; raw ADC <span id="gasRaw">--</span> of 4095</p>
          <p class="muted">Clean air baseline: <span id="cleanAir">--</span></p>
        </div>
      </div>
      <div class="gph">
        <div class="ghead"><h2>Gas graph</h2>${'$'}{ZB}</div>
        <div class="gscroll" id="gsc" tabindex="0" role="region" aria-label="Gas graph, scrolls sideways"><svg class="trace" id="trace" viewBox="0 0 720 230" preserveAspectRatio="none" role="img" aria-label="Live gas trace"></svg></div>
        <p class="muted">Dashed line: alarm threshold. Drag or swipe sideways for older data. Ctrl + mouse wheel or the +/- buttons zoom.</p>
      </div>
    </div>

    <div class="card wgt">
      <span class="lbl">Vibration (SW-420)</span>
      <div class="wtop">
        <div class="state"><i class="dot" id="vibDot" aria-hidden="true"></i><span id="vibState">--</span></div>
        <div>
          <p class="muted">Last vibration: <span id="vibLast">--</span></p>
          <p class="muted">A detection stays on screen for a few seconds after the last pulse.</p>
        </div>
      </div>
      <div class="gph">
        <div class="ghead"><h2>Vibration graph</h2>${'$'}{ZB}</div>
        <div class="gscroll" id="vsc" tabindex="0" role="region" aria-label="Vibration graph, scrolls sideways"><svg class="trace" id="vtrace" viewBox="0 0 720 120" preserveAspectRatio="none" role="img" aria-label="Live vibration trace" style="height:120px"></svg></div>
        <p class="muted">High = vibration detected. Moves together with the gas graph.</p>
      </div>
    </div>
  </section>
</main>

<script>`.split('${ZB}').join(zbar(['live', 'Live'])));

between('templates/index.html', '<script>', '</script>', String.raw`<script>
const $ = id => document.getElementById(id);
const S = [];                     // every sample: { t: time, g: gas or null, v: vibration 0/1 }
const MAXS = 7200;                // 1 hour at 2 samples per second (GRAPH_POINTS in config.py)
const SC = [$('gsc'), $('vsc')];  // the two scrolling graph boxes
const ZMIN = 0.1, ZMAX = 20;
let since = 0, busy = false, armed = true, zoom = 1, thr = 400;
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

/* ---------- zoomable, scrollable graphs ----------
   x is TIME: at 1x zoom 120 s fill the visible width. The newest sample is at the right edge. */
const atEnd = () => SC[0].scrollLeft + SC[0].clientWidth >= SC[0].scrollWidth - 6;
function showZoom(live) {
  const t = zoom.toFixed(zoom < 1 ? 2 : 1) + '\u00d7 \u00b7 ' + (live ? 'live' : 'scrolled back');
  document.querySelectorAll('.zlbl').forEach(e => { e.textContent = t; });
}
function onScroll() { showZoom(atEnd()); }

const IV = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
function ticks(L) {
  const r = [];
  if (!S.length) return r;
  const iv = IV.find(v => v * L.pps >= 90) || 3600;
  const o = iv < 60 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
  for (let t = Math.ceil(L.t0 / iv) * iv; t <= L.tEnd; t += iv) r.push({ x: L.x(t), s: new Date(t * 1000).toLocaleTimeString([], o) });
  return r;
}
function gridSvg(tk, base, h) {
  let g = '', s = '';
  tk.forEach(k => {
    g += '<line class="grid" x1="' + k.x.toFixed(1) + '" x2="' + k.x.toFixed(1) + '" y1="0" y2="' + base + '"/>';
    s += '<text class="tk" text-anchor="middle" x="' + k.x.toFixed(1) + '" y="' + (h - 3) + '">' + k.s + '</text>';
  });
  return [g, s];
}
function fit(el, L, h) { el.setAttribute('viewBox', '0 0 ' + L.total + ' ' + h); el.style.width = L.total + 'px'; }

function drawGas(L, tk) {
  const el = $('trace'), h = 230, base = h - 16, y = g => base - g / 1023 * base;
  const gs = gridSvg(tk, base, h);
  const segs = []; let cur = [], px = 0, pt = 0;
  for (const q of S) {
    if (q.g === null) { if (cur.length) segs.push(cur); cur = []; continue; }
    if (cur.length && q.t - pt > 3) { segs.push(cur); cur = []; }
    pt = q.t;
    const x = L.x(q.t);
    if (cur.length && x - px < 0.75) continue;      // zoomed far out: skip points closer than a pixel
    cur.push([x, y(q.g)]); px = x;
  }
  if (cur.length) segs.push(cur);
  let ar = '', ln = '';
  segs.forEach(s => {
    let p = '';
    s.forEach((c, i) => { p += (i ? 'L' : 'M') + c[0].toFixed(1) + ' ' + c[1].toFixed(1); });
    ln += '<path class="ln" d="' + p + '"/>';
    ar += '<path class="ar" d="' + p + 'L' + s[s.length - 1][0].toFixed(1) + ' ' + base + 'L' + s[0][0].toFixed(1) + ' ' + base + 'Z"/>';
  });
  fit(el, L, h);
  el.innerHTML = gs[0] + ar + '<line class="th" x1="0" x2="' + L.total + '" y1="' + y(thr).toFixed(1) + '" y2="' + y(thr).toFixed(1) + '"/>' + ln + gs[1];
}

function drawVib(L, tk) {
  const el = $('vtrace'), h = 120, base = h - 16, hi = 10, lo = base - 3;
  const gs = gridSvg(tk, base, h);
  fit(el, L, h);
  if (!S.length) { el.innerHTML = gs[0] + gs[1]; return; }
  let p = '', prev = 0, x0 = 0, x1 = 0;
  S.forEach((q, i) => {
    const x = L.x(q.t), Y = q.v ? hi : lo;
    if (i === 0) { p = 'M' + x.toFixed(1) + ' ' + Y; x0 = x; }
    else if (q.v !== prev) p += 'L' + x.toFixed(1) + ' ' + (prev ? hi : lo) + 'L' + x.toFixed(1) + ' ' + Y;
    prev = q.v; x1 = x;
  });
  p += 'L' + x1.toFixed(1) + ' ' + (prev ? hi : lo);
  el.innerHTML = gs[0]
    + '<path class="ar" d="' + p + 'L' + x1.toFixed(1) + ' ' + base + 'L' + x0.toFixed(1) + ' ' + base + 'Z"/>'
    + '<path class="ln" d="' + p + '"/>' + gs[1];
}

function redraw(keepScroll) {
  const follow = atEnd();
  const cw = SC[0].clientWidth || 720, n = S.length;
  const pps = cw / 120 * zoom, tEnd = n ? S[n - 1].t : 0, t0 = n ? S[0].t : 0;
  const total = Math.max(cw, Math.ceil((tEnd - t0) * pps));
  const L = { cw, pps, tEnd, t0, total, x: t => total - (tEnd - t) * pps };
  const tk = ticks(L);
  drawGas(L, tk); drawVib(L, tk);
  if (follow && !keepScroll) SC.forEach(s => { s.scrollLeft = s.scrollWidth; });
  showZoom(follow);
  return L;
}

function setZoom(z, anchor) {         // anchor 0..1 = which part of the visible width stays put
  z = Math.min(ZMAX, Math.max(ZMIN, z));
  const s = SC[0], cw = s.clientWidth, n = S.length, wasEnd = atEnd();
  if (!n) { zoom = z; showZoom(true); return; }
  const tA = S[n - 1].t - (s.scrollWidth - (s.scrollLeft + anchor * cw)) / (cw / 120 * zoom);
  zoom = z;
  const L = redraw(true);
  const left = wasEnd && anchor === 1 ? L.total : L.x(tA) - anchor * cw;
  SC.forEach(e => { e.scrollLeft = left; });
  showZoom(atEnd());
}
function goLive() { zoom = 1; redraw(true); SC.forEach(s => { s.scrollLeft = s.scrollWidth; }); showZoom(true); }
${'$'}{WIRE}
document.querySelectorAll('.zb').forEach(b => {
  b.onclick = () => {
    const k = b.dataset.z, a = atEnd() ? 1 : 0.5;
    if (k === 'in') setZoom(zoom * 1.5, a); else if (k === 'out') setZoom(zoom / 1.5, a); else goLive();
  };
});
window.addEventListener('resize', () => redraw());

/* ---------- live data ---------- */
function render(d) {
  document.body.dataset.s = d.status;
  armed = d.armed !== false;
  thr = d.threshold;
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

  const ab = $('armBtn');
  ab.disabled = false;
  ab.className = 'btn arm ' + (armed ? 'on' : 'off');
  ab.textContent = armed ? 'Armed \u00b7 tap to disarm' : 'Disarmed \u00b7 tap to arm';

  $('gasVal').textContent = d.gas === null ? '--' : d.gas;
  $('gasFill').style.width = (d.gas === null ? 0 : d.gas / 1023 * 100) + '%';
  $('gasTick').style.left = 'calc(' + d.threshold / 1023 * 100 + '% - 1px)';
  $('tickVal').textContent = d.threshold;
  $('gasVolt').textContent = d.gas_voltage === null ? '--' : d.gas_voltage;
  $('gasSrc').textContent = d.gas_source === 'esp32' ? 'ESP32' + (d.esp32_ip ? ' (' + d.esp32_ip + ')' : '') : d.gas_source === 'simulated' ? 'simulated' : 'no ESP32 data';
  $('gasRaw').textContent = d.gas_raw == null ? '--' : d.gas_raw;
  $('cleanAir').textContent = d.esp32_calibrating ? 'calibrating (30 s), keep the sensor in clean air...'
    : d.clean_air == null ? 'not calibrated (type C in the ESP32 serial monitor)' : d.clean_air + ' of 1023 (raw ' + d.clean_air_raw + ' of 4095)';

  $('vibDot').classList.toggle('on', d.vibration);
  $('vibState').textContent = d.vibration ? 'Vibration detected' : 'No vibration';
  $('vibLast').textContent = d.last_vib ? ago(d.ts - d.last_vib) : 'none since the app started';

  $('errors').hidden = d.errors.length === 0; list($('errorList'), d.errors);

  for (const q of d.series) { S.push({ t: q.t, g: q.gas, v: q.vib }); since = Math.max(since, q.t); }
  while (S.length > MAXS) S.shift();
  redraw();
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
</script>`.split('${WIRE}').join(WIRE));

/* ========================================================= templates/history.html */
between('templates/history.html',
  '  <section class="card">\n    <span class="lbl">Gas trend</span>',
  '<span id="vt1"></span></div>\n  </section>',
String.raw`  <section class="card">
    <div class="ghead"><span class="lbl">Gas trend</span>${'$'}{ZB}</div>
    <div class="gscroll" id="gsc" tabindex="0" role="region" aria-label="Gas history graph, scrolls sideways"><svg class="trace" id="trace" viewBox="0 0 720 260" preserveAspectRatio="none" role="img" aria-label="Historical gas trend" style="height:280px"></svg></div>
    <div class="axis"><span id="t0"></span><span>Dashed line: alarm threshold. Shaded bands: vibration seen. Drag or swipe sideways; Ctrl + mouse wheel or +/- to zoom.</span><span id="t1"></span></div>
    <p class="muted" id="empty" hidden>No data in this range yet. Leave the dashboard app running to collect readings.</p>
  </section>

  <section class="card">
    <div class="ghead"><span class="lbl">Vibration trend</span>${'$'}{ZB}</div>
    <div class="gscroll" id="vsc" tabindex="0" role="region" aria-label="Vibration history graph, scrolls sideways"><svg class="trace" id="vtrace" viewBox="0 0 720 160" preserveAspectRatio="none" role="img" aria-label="Historical vibration trend" style="height:180px"></svg></div>
    <div class="axis"><span id="vt0"></span><span>Bar height: share of readings with vibration (short events are drawn at a minimum height so they stay visible). Moves together with the gas graph.</span><span id="vt1"></span></div>
  </section>`.split('${ZB}').join(zbar(['reset', 'Reset'])));

between('templates/history.html', '<script>', '</script>', String.raw`<script>
const $ = id => document.getElementById(id);
const tm = ts => new Date(ts * 1000).toLocaleString();
function cell(tr, text) { const td = document.createElement('td'); td.textContent = text; tr.appendChild(td); }
const SC = [$('gsc'), $('vsc')];
const ZMAX = 40;
let zoom = 1, rng = { t0: 0, t1: 0 };

function query() {
  const p = $('preset').value;
  if (p !== 'custom') return 'range=' + p;
  const f = $('from').value, t = $('to').value;
  const s = f ? Math.floor(new Date(f) / 1000) : 0, e = t ? Math.floor(new Date(t) / 1000) : Math.floor(Date.now() / 1000) + 60;
  return 'start=' + s + '&end=' + e;
}

function draw(pts, thr) {
  const w = 720, h = 260, el = $('trace');
  if (!pts.length) { el.innerHTML = ''; rng = { t0: 0, t1: 0 }; return; }
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
  rng = { t0, t1: Math.max(t1, t0 + 1) };
}

function drawVib(pts) {
  const w = 720, h = 160, el = $('vtrace');
  if (!pts.length) { el.innerHTML = ''; return; }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, span = Math.max(1, t1 - t0), bw = Math.max(2, w / pts.length);
  let b = '';
  pts.forEach(q => {
    if (!q.vib) return;
    const bh = Math.max(24, (q.vib_pct == null ? 100 : q.vib_pct) / 100 * h);
    b += '<rect class="vb" style="opacity:.75" x="' + ((q.t - t0) / span * w).toFixed(1) + '" y="' + (h - bh).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '"/>';
  });
  el.innerHTML = b + '<line class="th" x1="0" x2="' + w + '" y1="' + (h - 1) + '" y2="' + (h - 1) + '" style="stroke-dasharray:none"/>';
}

/* ---------- zoom + horizontal scroll (both graphs share one zoom and one scroll position) ---------- */
function showRange() {
  document.querySelectorAll('.zlbl').forEach(e => { e.textContent = zoom.toFixed(1) + '\u00d7'; });
  const s = SC[0], W = s.scrollWidth || 1, span = rng.t1 - rng.t0;
  if (!span) { ['t0', 't1', 'vt0', 'vt1'].forEach(id => { $(id).textContent = ''; }); return; }
  const a = rng.t0 + s.scrollLeft / W * span, b = rng.t0 + Math.min(1, (s.scrollLeft + s.clientWidth) / W) * span;
  const label = t => span > 86400 ? new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : new Date(t * 1000).toLocaleTimeString();
  ['t0', 'vt0'].forEach(id => { $(id).textContent = label(a); });
  ['t1', 'vt1'].forEach(id => { $(id).textContent = label(b); });
}
function onScroll() { showRange(); }
function setZoom(z, anchor) {
  z = Math.min(ZMAX, Math.max(1, z));
  const s = SC[0], v = s.clientWidth, frac = (s.scrollLeft + anchor * v) / s.scrollWidth;
  zoom = z;
  SC.forEach(e => { e.firstElementChild.style.width = (z * 100) + '%'; });
  const left = frac * s.scrollWidth - anchor * v;
  SC.forEach(e => { e.scrollLeft = left; });
  showRange();
}
function resetZoom() { zoom = 1; SC.forEach(e => { e.firstElementChild.style.width = ''; e.scrollLeft = 0; }); showRange(); }
${'$'}{WIRE}
document.querySelectorAll('.zb').forEach(b => {
  b.onclick = () => { const k = b.dataset.z; if (k === 'in') setZoom(zoom * 1.5, 0.5); else if (k === 'out') setZoom(zoom / 1.5, 0.5); else resetZoom(); };
});
window.addEventListener('resize', showRange);

async function load() {
  const q = query();
  $('csv').href = '/export.csv?' + q;
  try {
    const r = await fetch('/api/history?' + q, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    draw(d.chart, d.threshold);
    drawVib(d.chart);
    showRange();
    $('empty').hidden = d.chart.length > 0; $('empty').textContent = 'No data in this range yet. Leave the dashboard app running to collect readings.';
    $('sN').textContent = d.stats.n; $('sMax').textContent = d.stats.max_gas ?? '--';
    $('sAvg').textContent = d.stats.avg_gas ?? '--'; $('sVib').textContent = d.stats.vib_samples ?? 0; $('sAlerts').textContent = d.alerts.length;
    $('alerts').replaceChildren(...d.alerts.map(a => { const tr = document.createElement('tr'); cell(tr, tm(a.ts)); cell(tr, a.kind); cell(tr, a.message); cell(tr, a.email_sent ? 'Sent' : '-'); return tr; }));
    $('rows').replaceChildren(...d.rows.map(x => { const tr = document.createElement('tr'); cell(tr, tm(x.ts)); cell(tr, x.gas); cell(tr, x.vib ? 'Detected' : 'No'); cell(tr, x.status); return tr; }));
  } catch (e) { $('empty').hidden = false; $('empty').textContent = 'Could not load history: ' + e.message; }
}

$('preset').onchange = () => { $('customBox').hidden = $('preset').value !== 'custom'; if ($('preset').value !== 'custom') { resetZoom(); load(); } };
$('apply').onclick = () => { resetZoom(); load(); };
load(); setInterval(() => { if ($('preset').value !== 'custom') load(); }, 15000);
</script>`.split('${WIRE}').join(WIRE));

/* ================================================================== write */
for (const [rel, e] of out) {
  const text = e.crlf ? e.text.replace(/\n/g, '\r\n') : e.text;
  if (DRY) console.log('[dry-run] would patch', rel);
  else { fs.writeFileSync(path.join(ROOT, rel), text); console.log('patched', rel); }
}
console.log(DRY ? '\nDry run OK: all anchors matched.' : '\nDone. Restart the app:  python app.py   (then hard-refresh the browser: Ctrl+Shift+R)');
