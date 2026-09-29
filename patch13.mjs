#!/usr/bin/env node
/**
 * patch13.mjs - act4embed, thirteenth round: PERFORMANCE for low-end devices (Raspberry Pi), same look.
 * Apply on top of patch12 (commit "Pop up", d993a8b).
 *
 * NOTHING VISIBLE IS REMOVED. Same colours, layout, graphs, zoom, scroll, hover and pop-up. What changes is how
 * much work the Pi (server) and the browser have to do to show them.
 *
 * BROWSER - what was slow
 *   1. Red alarm page: the whole <body> background was animated (repaints the full page 60x per second) with a
 *      blurred glass pop-up on top (the blur is recomputed every frame). Now the pulse is an opacity fade of one
 *      fixed layer (GPU only) and the pop-up uses a slightly denser plain overlay instead of backdrop-filter.
 *   2. Live graphs: the whole SVG (up to 7200 curve segments per graph) was rebuilt every second. Now only the
 *      part on screen (+1 screen either side) is drawn; scrolling/zooming redraws that window. The SVG keeps its
 *      full width, so scroll bars, zoom and "Live" behave exactly as before. Tick labels use one cached
 *      Intl.DateTimeFormat and only for the visible part (toLocaleTimeString per tick was very slow).
 *   3. Two requests per second per open page (the page AND alarm.js both polled /data). Pages now hand their
 *      answer to alarm.js, which only polls by itself if nobody feeds it.
 *   4. Polling and the History refresh pause while the tab is hidden; a failed poll retries after 3 s, not 1 s.
 *   5. Google Fonts no longer blocks the first paint (matters when the Pi has no internet: the page used to wait
 *      for the font request to time out). Fonts still load and swap in when they can.
 *   6. Text is only rewritten when it changed (no needless re-layout of the big headline), the hover pill is
 *      handled once per frame.
 *
 * SERVER - what was slow
 *   7. /data walked all 7200 samples on every request to find the 1-2 new ones; now it stops at the first old one.
 *   8. SQLite: WAL mode + synchronous=NORMAL (no SD-card flush on every commit), readings are written in one batch
 *      every 10 s instead of one connection + commit every 2 s, and old rows are pruned every 6 h (before, only
 *      at start-up). The last <= 10 s of readings can be missing from History after a power cut; alerts are still
 *      written immediately.
 *   9. /api/history read the selected range twice (chart + statistics); now once, on one connection.
 *  10. gzip for big answers (first page load ~270 KB -> ~30 KB; small /data answers stay uncompressed, level 3
 *      so the Pi's CPU is not burned) and a 1-day browser cache for /static (files use ?v=N, bumped below).
 *
 *   Files changed: app.py, static/style.css, static/alarm.js,
 *                  templates/index.html, templates/history.html, templates/settings.html
 *
 * Usage (from the repo root, next to app.py):
 *     node patch13.mjs --dry-run   check only, writes nothing
 *     node patch13.mjs
 * If an anchor doesn't match, NOTHING is written. Backups go to .patch13-backup/
 * Undo with:  git checkout -- app.py static templates
 * Then restart the app (stop the old python first!) and hard-refresh the browser (Ctrl+F5).
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
if (app0.includes('def _connect():')) { console.log('Already patched (patch13). Nothing to do.'); process.exit(0); }
if (!app0.includes('"warn_ack"')) fail('app.py is not the patch12 version. Pull the latest repo (git pull) first.');

/* ================================================================ app.py */

// 1) gzip middleware import
once('app.py',
String.raw`from fastapi.staticfiles import StaticFiles
`,
String.raw`from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware
`);

// 2) one place that opens the database (synchronous=NORMAL), used by every helper
once('app.py',
String.raw`def db_exec(sql, args=()):
    with closing(sqlite3.connect(DB_PATH, timeout=10)) as c:
        cur = c.execute(sql, args)
`,
String.raw`def _connect():
    """One short-lived connection. The database is in WAL mode (see init_db) and synchronous=NORMAL means a
    commit no longer waits for the SD card to flush every time: far less stutter on a Raspberry Pi."""
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.execute("PRAGMA synchronous=NORMAL")
    return c


def db_exec(sql, args=()):
    with closing(_connect()) as c:
        cur = c.execute(sql, args)
`);
once('app.py',
String.raw`def db_query(sql, args=()):
    with closing(sqlite3.connect(DB_PATH, timeout=10)) as c:
`,
String.raw`def db_query(sql, args=()):
    with closing(_connect()) as c:
`);
once('app.py',
String.raw`def init_db():
    with closing(sqlite3.connect(DB_PATH, timeout=10)) as c:
        c.executescript(
`,
String.raw`def init_db():
    with closing(_connect()) as c:
        try:
            c.execute("PRAGMA journal_mode=WAL")    # the History page can read while the logger writes
        except sqlite3.DatabaseError:
            pass
        c.executescript(
`);

// 3) batched logging + periodic pruning
once('app.py',
String.raw`# ----------------------------------------------------------------- esp32 input
`,
String.raw`# ---- batched logging: one commit per LOG_FLUSH_SECONDS instead of one connection + commit per reading
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


# ----------------------------------------------------------------- esp32 input
`);
once('app.py',
String.raw`db_exec("INSERT INTO readings(ts, gas, vib, status) VALUES(?,?,?,?)",
                        (int(now), gas, int(vibration), status))`,
String.raw`log_reading(now, gas, int(vibration), status)`);

// 4) /data: only walk back to the first sample the browser already has
once('app.py',
String.raw`        out["series"] = [p for p in series if p["t"] > since_ts]
`,
String.raw`        new = []
        for p in reversed(series):          # newest first: stop at the first sample the browser already has
            if p["t"] <= since_ts:
                break
            new.append(p)
        new.reverse()
        out["series"] = new
`);

// 5) static files: browser cache + gzip for big answers
once('app.py',
String.raw`app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
`,
String.raw`

class CachedStatic(StaticFiles):
    """Static files with a 1-day browser cache (the pages link them as ?v=N, so a new version is always fetched)."""
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if resp.status_code in (200, 304):
            resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp


# only answers > 1.5 KB are compressed (the small once-a-second /data answers are not); level 3 = light on the Pi CPU
app.add_middleware(GZipMiddleware, minimum_size=1500, compresslevel=3)
app.mount("/static", CachedStatic(directory=os.path.join(BASE_DIR, "static")), name="static")
`);

// 6) /api/history: ONE pass over the range for chart + statistics, one connection for everything
span('app.py',
String.raw`    chart = db_query(
`,
String.raw`    return JSONResponse({"chart": chart, "rows": rows,`,
String.raw`    with closing(_connect()) as c:
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
`);

/* ================================================================ style.css */

// red page pulse: fade one fixed layer instead of repainting the whole body background
once('static/style.css',
String.raw`body[data-s=danger]{animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{50%{background:#8f0d15}}`,
String.raw`body::before{content:"";position:fixed;inset:0;z-index:-1;background:#8f0d15;opacity:0;pointer-events:none}
body[data-s=danger]::before{animation:pulse 1.8s ease-in-out infinite;will-change:opacity}
@keyframes pulse{50%{opacity:1}}`);
once('static/style.css',
String.raw`body[data-s=danger]{animation:none}}`,
String.raw`body[data-s=danger]::before{animation:none}}`);

// pop-up: plain (slightly denser) overlay instead of a live backdrop blur
once('static/style.css',
String.raw`background:radial-gradient(circle at 50% 30%,rgba(179,18,27,.35),rgba(6,8,12,.82) 70%);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);`,
String.raw`background:radial-gradient(circle at 50% 30%,rgba(120,14,22,.9),rgba(6,8,12,.95) 70%);`);

/* ================================================================ alarm.js */

// take the page's own /data answer instead of asking again; sleep while the tab is hidden
once('static/alarm.js',
String.raw`  async function poll(force) {
    if (!force && (busy || resetting)) return;`,
String.raw`  let fedAt = 0;                                       // last time the page handed us a fresh /data answer
  window.alarmGen = () => gen;
  window.alarmFeed = (d, g) => {                       // pages that already poll /data pass the answer here (no 2nd request)
    if (!d || g !== gen || resetting) return;          // answer is older than a Reset: ignore it
    fedAt = Date.now();
    if (d.status) document.body.dataset.s = d.status;
    try { update(d); } catch (e) { console.error('[alarm] pop-up error:', e); }
  };

  async function poll(force) {
    if (!force && (busy || resetting || document.hidden || Date.now() - fedAt < 2500)) return;`);
once('static/alarm.js',
String.raw`  poll(); setInterval(poll, 1000);
})();`,
String.raw`  poll(); setInterval(poll, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();`);

/* ================================================================ fonts + cache-bust (all pages) */
const FONT = String.raw`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&family=Figtree:wght@400;600&display=swap">`;
const FONT_NEW = String.raw`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&family=Figtree:wght@400;600&display=swap" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&family=Figtree:wght@400;600&display=swap"></noscript>`;
for (const f of ['templates/index.html', 'templates/history.html', 'templates/settings.html']) {
  once(f, FONT, FONT_NEW);                       // font request no longer blocks the first paint
  once(f, '/static/style.css?v=9"', '/static/style.css?v=10"');
  once(f, '/static/alarm.js?v=10"', '/static/alarm.js?v=11"');
}

/* ================================================================ settings.html */
once('templates/settings.html',
String.raw`async function poll() {
  if (busy) return; busy = true;
  try {
    const r = await fetch('/data?since=1e18', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    sync(await r.json());`,
String.raw`async function poll() {
  if (busy || document.hidden) return; busy = true;
  const g = window.alarmGen ? window.alarmGen() : 0;
  try {
    const r = await fetch('/data?since=1e18', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    if (window.alarmFeed) window.alarmFeed(d, g);
    sync(d);`);
once('templates/settings.html',
String.raw`loadEmail(); poll(); setInterval(poll, 1000);`,
String.raw`loadEmail(); poll(); setInterval(poll, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });`);

/* ================================================================ history.html */
once('templates/history.html',
String.raw`load(); setInterval(() => { if ($('preset').value !== 'custom') load(); }, 15000);`,
String.raw`load(); setInterval(() => { if (!document.hidden && $('preset').value !== 'custom') load(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('preset').value !== 'custom') load(); });`);

/* ================================================================ index.html (live page) */
const IX = 'templates/index.html';

// helpers: write text only when it changed
once(IX,
String.raw`const $ = id => document.getElementById(id);
const S = [];`,
String.raw`const $ = id => document.getElementById(id);
function setText(id, v) { const e = $(id); v = String(v); if (e.textContent !== v) e.textContent = v; }   // no re-layout when unchanged
let errKey = '', drawnThr = null;
const S = [];`);

// scrolling: redraw the visible window when the view gets close to the edge of what is drawn
once(IX,
String.raw`function onScroll() { showZoom(atEnd()); }`,
String.raw`let raf = 0;
function later() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; redraw(true); }); }
function onScroll() {
  showZoom(atEnd());
  if (!DR) return;
  const l = SC[0].scrollLeft, cw = SC[0].clientWidth, m = cw * 0.3;
  if ((DR.a > 0 && l < DR.a + m) || (DR.b < DR.total && l + cw > DR.b - m)) later();
}`);

// ticks: cached formatter, only for the drawn part
span(IX,
String.raw`function ticks(L) {`,
String.raw`const PAD = 12;`,
String.raw`const TF = {};                   // one Intl.DateTimeFormat per label style (toLocaleTimeString per tick was very slow)
function fmtTick(t, sec) {
  const f = TF[sec] || (TF[sec] = new Intl.DateTimeFormat([], sec ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' }));
  return f.format(t * 1000);
}
function ticks(L, a, b) {         // a..b = the drawn part of the graph, in px
  const r = [];
  if (!S.length) return r;
  const iv = IV.find(v => v * L.pps >= 90) || 3600;
  const ta = Math.max(L.t0, timeAt(L, a) - iv), tb = Math.min(L.tEnd, timeAt(L, b) + iv);
  for (let t = Math.ceil(ta / iv) * iv; t <= tb; t += iv) r.push({ x: L.x(t), s: fmtTick(t, iv < 60) });
  return r;
}
`);

// gradient: fixed in page coordinates so it looks the same wherever the drawn window is
span(IX,
String.raw`const AUR_DEFS = `,
String.raw`function gridSvg(`,
String.raw`function aurDefs(y1, y2) {
  return '<defs><linearGradient id="aurG" gradientUnits="userSpaceOnUse" x1="0" y1="' + y1.toFixed(1) + '" x2="0" y2="' + y2.toFixed(1) + '"><stop offset="0" style="stop-color:var(--acc);stop-opacity:.42"/><stop offset="1" style="stop-color:var(--acc);stop-opacity:0"/></linearGradient></defs>';
}
`);

// drawing: only the samples on (and next to) the screen
span(IX,
String.raw`function drawGas(L, tk) {`,
String.raw`SC.forEach((s, i) => {`,
String.raw`/* ---------- draw only what is on screen ----------
   The SVG keeps its full width (scrolling, zoom and layout are unchanged) but only the samples between
   [scrollLeft - 1 screen] and [scrollLeft + 2 screens] are turned into path data. */
const MINGAP = 1.25;             // px: samples closer than this are merged (invisible with a 2.5 px line)
let DR = null;                   // px range that is drawn right now { a, b, total }
function timeAt(L, x) { return L.tEnd - (L.total - PAD - x) / L.pps; }
function firstAtOrAfter(t) {     // binary search: S is sorted by time
  let lo = 0, hi = S.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (S[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}
function windowOf(L, left) {
  const a = Math.max(0, left - L.cw), b = Math.min(L.total, left + 2 * L.cw);
  const i0 = firstAtOrAfter(timeAt(L, a)), i1 = firstAtOrAfter(timeAt(L, b));
  return { a, b, i0: Math.max(0, i0 - 1), i1: Math.min(S.length, i1 + 1) };   // one extra sample each side keeps the line joined
}

function drawGas(L, tk, W) {
  const el = $('trace'), h = 230, base = h - 16, y = g => base - g / 1023 * (base - 8);
  const gs = gridSvg(tk, base, h, L.total, [0.25, 0.5, 0.75]);
  const lastI = S.length - 1;
  const segs = []; let cur = [], px = 0, pt = 0;
  for (let i = W.i0; i < W.i1; i++) {
    const q = S[i];
    if (q.g === null) { if (cur.length) segs.push(cur); cur = []; continue; }
    if (cur.length && q.t - pt > 3) { segs.push(cur); cur = []; }
    pt = q.t;
    const x = L.x(q.t);
    if (cur.length && x - px < MINGAP && i !== lastI) continue;      // zoomed far out: skip points closer than ~1 px
    cur.push([x, y(q.g)]); px = x;
  }
  if (cur.length) segs.push(cur);
  let gmax = 0;                                                       // fill gradient fades from the highest reading
  for (let i = 0; i <= lastI; i++) { const g = S[i].g; if (g !== null && g > gmax) gmax = g; }
  let ar = '', ln = '';
  segs.forEach(s => {
    const d = curve(s), a = s[0][0].toFixed(1), b = s[s.length - 1][0].toFixed(1);
    ln += '<path class="ln" d="' + d + '"/>';
    ar += '<path d="' + d + 'L' + b + ' ' + base + 'L' + a + ' ' + base + 'Z" fill="url(#aurG)"/>';
  });
  const ty = y(thr), last = S[lastI];
  const zone = '<rect class="zone" x="0" y="8" width="' + L.total + '" height="' + Math.max(0, ty - 8).toFixed(1) + '"/>';
  const tl = '<line class="thr" x1="0" x2="' + L.total + '" y1="' + ty.toFixed(1) + '" y2="' + ty.toFixed(1) + '"/>'
    + '<text class="thl" text-anchor="end" x="' + (L.total - 8) + '" y="' + (ty < 26 ? ty + 15 : ty - 7).toFixed(1) + '">Alarm ' + thr + '</text>';
  let dot = '';
  if (last && last.g !== null) {
    const cx = L.x(last.t).toFixed(1), cy = y(last.g).toFixed(1);
    dot = '<circle class="halo" cx="' + cx + '" cy="' + cy + '" r="10"/><circle class="dotp" cx="' + cx + '" cy="' + cy + '" r="5"/>';
  }
  fit(el, L, h);
  el.innerHTML = aurDefs(Math.min(y(gmax), base - 1), base) + zone + gs[0] + ar + tl + ln + dot + gs[1];
}

function drawVib(L, tk, W) {
  const el = $('vtrace'), h = 120, base = h - 16, hi = 10, lo = base - 3;
  const gs = gridSvg(tk, base, h, L.total);
  fit(el, L, h);
  if (W.i1 <= W.i0) { el.innerHTML = gs[0] + gs[1]; return; }
  let p = '', prev = 0, x0 = 0, x1 = 0;
  for (let i = W.i0; i < W.i1; i++) {
    const q = S[i], x = L.x(q.t), Y = q.v ? hi : lo;
    if (i === W.i0) { p = 'M' + x.toFixed(1) + ' ' + Y; x0 = x; }
    else if (q.v !== prev) p += 'L' + x.toFixed(1) + ' ' + (prev ? hi : lo) + 'L' + x.toFixed(1) + ' ' + Y;
    prev = q.v; x1 = x;
  }
  p += 'L' + x1.toFixed(1) + ' ' + (prev ? hi : lo);
  el.innerHTML = gs[0]
    + '<path class="ar" d="' + p + 'L' + x1.toFixed(1) + ' ' + base + 'L' + x0.toFixed(1) + ' ' + base + 'Z"/>'
    + '<path class="ln" d="' + p + '"/>' + gs[1];
}

function layout() {
  const cw = SC[0].clientWidth || 720, n = S.length;
  const pps = cw / 120 * zoom, tEnd = n ? S[n - 1].t : 0, t0 = n ? S[0].t : 0;
  const total = Math.max(cw, Math.ceil((tEnd - t0) * pps) + PAD);
  return { cw, pps, tEnd, t0, total, x: t => total - PAD - (tEnd - t) * pps };
}

function redraw(keepScroll, left) {   // left = scroll position the view will have (default: current, or the live edge)
  const follow = atEnd();
  const L = layout();
  if (left === undefined) left = follow && !keepScroll ? L.total - L.cw : SC[0].scrollLeft;
  const W = windowOf(L, left);
  const tk = ticks(L, W.a, W.b);
  LL = L; DR = { a: W.a, b: W.b, total: L.total };
  drawGas(L, tk, W); drawVib(L, tk, W);
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
  const L0 = layout();
  const left = Math.max(0, Math.min(L0.total - cw, wasEnd ? L0.total : L0.x(tA) - anchor * cw));
  redraw(true, left);
  SC.forEach(e => { e.scrollLeft = left; });
  showZoom(atEnd());
}
function goLive() { zoom = 1; const L = layout(); redraw(true, L.total - L.cw); SC.forEach(s => { s.scrollLeft = s.scrollWidth; }); showZoom(true); }

`);

// hover pill: handled once per frame
span(IX,
String.raw`  const hide = () => { tip.hidden = gl.hidden = true; };
`,
String.raw`}
hoverTip(SC[0], xc => {`,
String.raw`  let hev = null, hraf = 0;                          // pointer moves are handled once per frame
  const hide = () => { hev = null; tip.hidden = gl.hidden = true; };
  const move = () => {
    hraf = 0;
    const e = hev;
    if (!e || e.pointerType !== 'mouse' || sc.classList.contains('drag')) return hide();
    const r = sc.getBoundingClientRect(), c = card.getBoundingClientRect();
    const txt = lookup(e.clientX - r.left + sc.scrollLeft, sc.scrollWidth);
    if (!txt) return hide();
    tip.textContent = txt; tip.hidden = gl.hidden = false;
    const x = e.clientX - c.left, w = tip.offsetWidth / 2 + 8;
    gl.style.left = x + 'px'; gl.style.top = (r.top - c.top) + 'px'; gl.style.height = r.height + 'px';
    tip.style.left = Math.min(Math.max(x, w), c.width - w) + 'px'; tip.style.top = (r.top - c.top + 8) + 'px';
  };
  sc.addEventListener('pointerleave', hide);
  sc.addEventListener('pointermove', e => { hev = e; if (!hraf) hraf = requestAnimationFrame(move); });
`);

// render(): only touch the DOM when something changed
once(IX,
String.raw`  $('verdict').textContent = t; $('sub').textContent = s;`,
String.raw`  setText('verdict', t); setText('sub', s);`);

span(IX,
String.raw`  $('gasVal').textContent =`,
String.raw`  for (const q of d.series)`,
String.raw`  setText('gasVal', d.gas === null ? '--' : d.gas);
  $('gasFill').style.width = (d.gas === null ? 0 : d.gas / 1023 * 100) + '%';
  $('gasTick').style.left = 'calc(' + d.threshold / 1023 * 100 + '% - 1px)';
  setText('tickVal', d.threshold);
  setText('gasVolt', d.gas_voltage === null ? '--' : d.gas_voltage);
  setText('gasSrc', d.gas_source === 'esp32' ? 'ESP32' + (d.esp32_ip ? ' (' + d.esp32_ip + ')' : '') : d.gas_source === 'simulated' ? 'simulated' : 'no ESP32 data');
  setText('gasRaw', d.gas_raw == null ? '--' : d.gas_raw);
  setText('cleanAir', d.esp32_calibrating ? 'calibrating (30 s), keep the sensor in clean air...'
    : d.clean_air == null ? 'not calibrated (type C in the ESP32 serial monitor)' : d.clean_air + ' of 1023 (raw ' + d.clean_air_raw + ' of 4095)');

  setText('vibState', d.vibration ? 'Vibration detected' : 'No vibration');
  setText('vibLast', d.last_vib ? ago(d.ts - d.last_vib) : 'none since the app started');

  const ek = d.errors.join('\n');
  if (ek !== errKey) { errKey = ek; $('errors').hidden = d.errors.length === 0; list($('errorList'), d.errors); }

`);

once(IX,
String.raw`  while (S.length > MAXS) S.shift();
  redraw();
`,
String.raw`  if (S.length > MAXS) S.splice(0, S.length - MAXS);
  if (d.series.length || d.threshold !== drawnThr) { drawnThr = d.threshold; redraw(); }   // nothing new: nothing to redraw
`);

// polling: share the answer with alarm.js, sleep while hidden, back off when the Pi does not answer
span(IX,
String.raw`async function poll() {`,
String.raw`async function control(action) {`,
String.raw`let timer = 0;
function next(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }
async function poll() {
  if (busy) return;
  if (document.hidden) return;                     // resumes from the visibilitychange handler below
  busy = true;
  let ok = false;
  const g = window.alarmGen ? window.alarmGen() : 0;
  try {
    const r = await fetch('/data?since=' + since, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    if (window.alarmFeed) window.alarmFeed(d, g);  // pop-up + page colour from the same answer (alarm.js does not ask again)
    render(d);
    ok = true;
  } catch (e) {
    document.body.dataset.s = 'error';
    $('verdict').textContent = 'No connection';
    $('sub').textContent = 'Cannot reach the Raspberry Pi. Check that app.py is running and that you are on the same network.';
  } finally { busy = false; }
  next(ok ? 1000 : 3000);
}

`);
once(IX,
String.raw`poll(); setInterval(poll, 1000);
</script>`,
String.raw`poll();
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
</script>`);

/* ================================================================ write */
for (const [rel, e] of out) {
  if (e.text === e.raw.replace(/\r\n/g, '\n')) continue;
  console.log((DRY ? '[dry-run] would patch ' : 'patching ') + rel);
  if (DRY) continue;
  const bak = path.join(ROOT, '.patch13-backup', rel);
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.writeFileSync(bak, e.raw);
  fs.writeFileSync(path.join(ROOT, rel), e.crlf ? e.text.replace(/\n/g, '\r\n') : e.text);
}
console.log(DRY ? '\nDry run OK: all anchors matched.' : '\nDone. Stop the old app.py, then start it again:  python app.py   (and Ctrl+F5 in the browser)');
