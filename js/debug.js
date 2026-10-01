// Performance panel for testing on real phones. Open the game with ?debug and
// play a game: it shows the frame rate, the quality Auto settled on, load
// times and the device, and keeps a summary of the whole session to screenshot
// or copy. None of this loads unless asked for.

const BUCKETS = 2001;             // frame-time histogram, 1 ms per bucket (up to the 2 s stall cutoff)

const newStats = () => ({ n: 0, t: 0, hist: new Uint32Array(BUCKETS), hitches: 0 });
function add(s, real) {
  s.n++; s.t += real;
  s.hist[Math.min(BUCKETS - 1, Math.round(real * 1000))]++;
  if (real > 0.05) s.hitches++;
}
// frame rate of the slowest 1% of frames
function low1(s) {
  let k = Math.max(1, Math.floor(s.n * 0.01));
  for (let i = BUCKETS - 1; i > 0; i--) { k -= s.hist[i]; if (k <= 0) return 1000 / i; }
  return 0;
}
// share of frames slower than `fps`
function under(s, fps) {
  let k = 0;
  for (let i = Math.ceil(1000 / fps); i < BUCKETS; i++) k += s.hist[i];
  return s.n ? k / s.n : 0;
}

const f0 = (x) => Math.round(x).toString();
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const sec = (ms) => (ms / 1000).toFixed(1) + ' s';
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const BARS = '▁▂▃▄▅▆▇█';
const spark = (a) => a.map((v) => BARS[Math.max(0, Math.min(7, Math.round((v - 20) / 40 * 7)))]).join('');

function device() {
  const ua = navigator.userAgent;
  let d = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone'
      : (ua.match(/Android [\d.]+; ([^;)]+)/) || [])[1] || (/Android/.test(ua) ? 'Android' : navigator.platform || 'desktop');
  const ios = ua.match(/OS (\d+)_(\d+)/), and = ua.match(/Android ([\d.]+)/);
  if (ios && /iPhone|iPad/.test(d)) d += ` iOS ${ios[1]}.${ios[2]}`;
  else if (and) d += ` Android ${and[1]}`;
  const b = /CriOS/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /SamsungBrowser/.test(ua) ? 'Samsung'
    : /EdgA?\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '?';
  return `${d} ${b}`;
}

function gpuName(r) {
  try {
    const gl = r.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch (e) { return '?'; }
}

// what the page downloaded: the player models, and everything in total
function downloads() {
  const res = performance.getEntriesByType('resource');
  const nav = performance.getEntriesByType('navigation')[0];
  let total = nav ? nav.transferSize : 0, cached = 0;
  const m = { bytes: 0, start: Infinity, end: 0, fmt: '' };
  for (const e of res) {
    total += e.transferSize;
    if (!e.transferSize && e.decodedBodySize) cached++;
    if (/\/models\/(?!motion)[^/]+\.(glb|json)$/.test(e.name)) {
      m.bytes += e.transferSize || e.encodedBodySize;
      m.start = Math.min(m.start, e.startTime); m.end = Math.max(m.end, e.responseEnd);
      const ext = e.name.endsWith('.glb') ? 'glb' : 'json';
      if (!m.fmt.includes(ext)) m.fmt += (m.fmt ? '+' : '') + ext;
    }
  }
  return { total, cached, files: res.length, models: m };
}

export function startDebug(hw) {
  try { performance.setResourceTimingBufferSize(600); } catch (e) { /* older browsers */ }
  const css = document.createElement('style');
  css.textContent = `
#dbg { position: fixed; z-index: 20; top: calc(var(--sat) + 58px); left: calc(var(--sal) + 12px); max-width: calc(100vw - var(--sal) - 24px);
  background: rgba(0,0,0,.68); color: #e9e9e9; font: 10.5px/1.38 ui-monospace, Menlo, monospace; padding: 6px 8px; pointer-events: none; }
#dbg pre { margin: 0; font: inherit; white-space: pre-wrap; }
#dbg .bar { display: flex; gap: 6px; margin-bottom: 4px; }
#dbg button { pointer-events: auto; font: 700 10.5px/1 ui-monospace, Menlo, monospace; color: #111; background: #e9e9e9; border: 0; padding: 6px 9px; }
#dbg b.g { color: #5fe08a; } #dbg b.a { color: #ffc34d; } #dbg b.r { color: #ff6b5e; }
#dbg.min pre { display: none; }`;
  document.head.appendChild(css);
  const el = document.createElement('div');
  el.id = 'dbg';
  el.innerHTML = '<div class="bar"><b></b><button data-a="copy">Copy report</button><button data-a="min">Hide</button></div><pre></pre>';
  document.body.appendChild(el);
  const head = el.querySelector('b'), pre = el.querySelector('pre');

  const play = newStats(), replays = newStats();
  const curve = [];                 // play fps per 10 s (shows a phone slowing as it heats up)
  const seg = { n: 0, t: 0 };
  const scaleT = new Map();         // seconds of play at each render scale
  const now = { n: 0, t: 0, worst: 0, fps: 0, worstMs: 0 };
  let renderer = null, gpu = '?', draws = 0, tris = 0, sinceText = 0;

  function frame(real) {
    const r = hw.renderer;
    if (r && r !== renderer) { renderer = r; r.info.autoReset = false; gpu = gpuName(r); }
    if (r) { draws = r.info.render.calls; tris = r.info.render.triangles; r.info.reset(); }
    if (real > 2) return;           // the page was suspended (the game pauses itself when hidden)
    now.n++; now.t += real; now.worst = Math.max(now.worst, real);
    if (now.t >= 0.5) { now.fps = now.n / now.t; now.worstMs = now.worst * 1000; now.n = now.t = now.worst = 0; }
    if (hw.game && !hw.paused) {
      if (hw.replayActive) add(replays, real);
      else {
        add(play, real);
        const k = hw.scale.toFixed(2);
        scaleT.set(k, (scaleT.get(k) || 0) + real);
        seg.n++; seg.t += real;
        if (seg.t >= 10) { curve.push(seg.n / seg.t); seg.n = seg.t = 0; }
      }
    }
    sinceText += real;
    if (sinceText >= 0.5) { sinceText = 0; render(); }
  }

  // brief: just the essentials while playing, so the panel stays off the court
  function lines(full, brief = false) {
    const q = hw.settings.quality, tier = hw.tier;
    const c = hw.canvas, L = [];
    L.push(`quality ${q}${q === 'auto' ? ' → ' + tier : ''} · scale ${hw.scale.toFixed(2)} · ${c.width}×${c.height} px`);
    if (brief) {
      if (play.n) L.push(`play ${clock(play.t)} · avg ${f0(play.n / play.t)} · 1% low ${f0(low1(play))} · hitches ${play.hitches}`);
      return L;
    }
    L.push(`draws ${draws} · ${f0(tris / 1000)}k tris · ${renderer ? renderer.info.memory.textures : 0} textures`);
    if (play.n) {
      L.push(`play ${clock(play.t)} · avg ${f0(play.n / play.t)} · 1% low ${f0(low1(play))} · hitches ${play.hitches}`);
      const sc = [...scaleT].sort((a, b) => b[0] - a[0]).map(([k, t]) => `${k}:${f0(t / play.t * 100)}%`).join(' ');
      L.push(`under 45 fps ${f0(under(play, 45) * 100)}% · scale ${sc}`);
      if (curve.length) L.push(`fps per 10 s ${spark(curve)}${full ? '  ' + curve.map(f0).join(' ') : ''}`);
    } else L.push('play: start a game to measure');
    const clip = hw.replay.clip;
    const rec = clip ? `${clip.blob.type || '?'} ${mb(clip.blob.size)}` : window.MediaRecorder ? 'none yet' : 'unsupported';
    L.push(`replays ${replays.n ? `avg ${f0(replays.n / replays.t)} · 1% low ${f0(low1(replays))}` : 'none yet'} · clip ${rec}`);
    const d = downloads(), m = d.models, T = hw.timing;
    L.push(`load ${T.ready ? sec(T.ready) : '…'}${T.match ? ` · start ${sec(T.match)}` : ''} · models ${m.fmt || '?'} ${mb(m.bytes)}${m.end ? ' in ' + sec(m.end - m.start) : ''}`);
    L.push(`downloaded ${mb(d.total)} · ${d.files} files${d.cached ? ` (${d.cached} cached)` : ''}`);
    const v = hw.ldBall, ac = hw.sound.ctx;
    const ball = v ? `${(v.currentSrc.match(/\.(\w+)$/) || [])[1] || 'none'} ${v.played.length ? 'played' : 'poster only'}` : '?';
    L.push(`ball ${ball} · audio ${ac ? `${ac.state} ${ac.sampleRate / 1000}k` : 'off until Start'}`);
    const mem = navigator.deviceMemory ? ` · ${navigator.deviceMemory} GB` : '';
    L.push(`${device()} · ${innerWidth}×${innerHeight} @${devicePixelRatio}x · ${navigator.hardwareConcurrency || '?'} cores${mem}`);
    const g = gpu.replace(/^ANGLE \((.*)\)$/, '$1').replace(/, Unspecified Version|, SwiftShader driver/, '');
    L.push(`GPU ${full || g.length < 56 ? g : g.slice(0, 54) + '…'}`);
    if (full) {
      L.push(`frame times in play (ms:count) ${[...play.hist].map((n, i) => (n ? `${i}:${n}` : '')).filter(Boolean).join(' ')}`);
      L.push(`page ${location.href}`, `ua ${navigator.userAgent}`, `at ${new Date().toISOString()}`);
    }
    return L;
  }

  function render() {
    const fps = now.fps;
    head.className = fps >= 55 ? 'g' : fps >= 40 ? 'a' : 'r';
    head.textContent = `${f0(fps)} fps · worst ${f0(now.worstMs)} ms`;
    const playing = hw.game && !hw.paused && !hw.game.over;
    if (!el.classList.contains('min')) pre.textContent = lines(false, playing).join('\n');
  }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'min') { el.classList.toggle('min'); b.textContent = el.classList.contains('min') ? 'Show' : 'Hide'; render(); return; }
    const text = `Livewire Hoops debug\n${head.textContent}\n${lines(true).join('\n')}`;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (err) {
      const t = document.createElement('textarea');
      t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(t); t.select();
      try { ok = document.execCommand('copy'); } catch (err2) { /* nothing left to try */ }
      t.remove();
    }
    b.textContent = ok ? 'Copied' : 'Copy failed: screenshot';
    setTimeout(() => { b.textContent = 'Copy report'; }, 2500);
  });

  return { frame, report: () => lines(true).join('\n') };
}
