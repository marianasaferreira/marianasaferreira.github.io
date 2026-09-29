/*
 * dither-filter — 1-bit Bayer dithering for images, sprite-sheet animations and
 * video, with an optional cursor smear.
 *
 * Quick start:
 *   DitherFilter.mount({ canvas: '#hero-canvas', src: 'photo.jpg' });
 *
 * See README.md for the full option list and, more importantly, for the
 * non-obvious constraints of this medium (why features vanish, why gamma rather
 * than brightness, why the noise must be seeded). Those are easy to re-break.
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    canvas: null,
    src: null,
    type: 'auto',          // 'auto' | 'image' | 'sprite' | 'video'
    sprite: null,          // { frames, cols, rows } — required for type 'sprite'
    duration: 9000,        // ms for one sprite playthrough
    loop: false,
    autoplay: true,        // false: mount and show the scene, but hold the subject
                           // at its first frame, unseen, until handle.play()
    block: 3,              // dither cell size in CSS px
    gamma: 1.0,            // >1 thins coverage, <1 thickens it. Maps 0 to 0.
    grain: 14,             // seeded noise ≈ one Bayer step; dissolves banding
    ink: '#EAEAEA',
    paper: '#121212',
    fadeIn: 500,           // ms, so the first frame arrives rather than pops
    // anchorY picks which point of the media sits at y: 0 top edge, 0.5 centre,
    // 1 bottom edge — so { y: 1, anchorY: 1 } rests it on the bottom at any size
    placement: { x: 0.5, y: 0.5, size: 1.0, designWidth: 0, anchorY: 0.5 },
    shape: null,           // (u, v) => ({ gain, hollow }) in flower space
    edgeRef: 34,           // gradient counted as a full edge when hollowing
    cursor: {
      enabled: true,
      drag: 0.18,          // how hard the smear head lags the pointer
      radius: 0.13,        // reach, as a fraction of the short side
      strength: 0.42,      // how much of the cursor's motion pixels pick up
      dissipation: 0.90,   // field retained per frame; lower fades sooner
      max: 26,             // cap on displacement, in CSS px
      blur: 0,             // 0..1, softens smeared pixels in proportion to their push
      fray: 0              // 0..1: 0 drags the image, 1 scatters it into loose dots like dust
    },
    // a procedural field behind the subject, dithered in the same pass. Levels
    // are 0..1 of full ink. It needs a transparent source to sit *behind* the
    // subject; with an opaque one, use blend 'lighten'.
    background: {
      gradient: 'flat',    // 'flat' | 'linear' | 'radial'
      from: 0,             // flat level, or the gradient's start / centre
      to: 0.4,             // the gradient's end / rim
      angle: 90,           // linear only, degrees; 90 runs top → bottom
      noise: 0,            // 0..1, how far value noise swings the level
      scale: 80,           // noise feature size in CSS px
      octaves: 2,
      speed: 0,            // noise drift in px/s; > 0 keeps the loop running
      pattern: 'bayer',    // 'bayer' | 'random' — random scatters, no grid
      shimmer: 0,          // re-rolls per second of the random pattern
      blend: 'behind',     // 'behind' (uses alpha) | 'lighten' (max)
      seed: 1
    },
    onReady: null
  };

  const FRAY_REACH = 16;           // CSS px the fray's dust can scatter at most

  const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

  const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
  // deterministic hash — NEVER Math.random() for anything spatial, or a resize
  // re-scrambles the whole pattern (see README)
  const rnd = (i) => { const s = Math.sin(i * 127.1) * 43758.5453; return s - Math.floor(s); };

  function deepMerge(base, over) {
    const out = Object.assign({}, base);
    for (const k in over) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && !(over[k] instanceof Element)) {
        out[k] = deepMerge(base[k] || {}, over[k]);
      } else if (over[k] !== undefined) {
        out[k] = over[k];
      }
    }
    return out;
  }

  function hexToRGB(hex) {
    let h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  function detectType(src, sprite) {
    if (sprite) return 'sprite';
    if (src instanceof HTMLVideoElement) return 'video';
    if (typeof src === 'string' && /\.(mp4|webm|mov|m4v)(\?|$)/i.test(src)) return 'video';
    return 'image';
  }

  function mount(userOpts) {
    const o = deepMerge(DEFAULTS, userOpts || {});
    const canvas = typeof o.canvas === 'string' ? document.querySelector(o.canvas) : o.canvas;
    if (!canvas) throw new Error('DitherFilter: canvas not found');
    const ctx = canvas.getContext('2d');
    const host = canvas.parentElement;

    const INK = hexToRGB(o.ink);
    const PAPER = hexToRGB(o.paper);
    const BLOCK = o.block;
    const type = o.type === 'auto' ? detectType(o.src, o.sprite) : o.type;

    // thresholds, 0..255
    const TH = new Float32Array(16);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) TH[y * 4 + x] = (BAYER4[y][x] + 0.5) / 16 * 255;
    }
    // Tone curve. Gamma, not brightness/contrast: it maps 0 to exactly 0, so the
    // empty background can never be lifted above the lowest threshold and speckle.
    const LUT = new Float32Array(256);
    for (let v = 0; v < 256; v++) LUT[v] = 255 * Math.pow(v / 255, o.gamma);

    let W, H, DPR, cols, rows;
    let grain, gainMap, hollowMap, turb, fx, fy, outImage;
    let frayDir, frayTick = 0;          // per-cell random offsets for the fray, and its clock
    let fieldLive = false, hadMotion = false;
    let L, A;                          // per-cell subject luma (premultiplied) and alpha
    let satL, satA, satB;              // summed-area tables, for the smear blur
    let gradMap, bgLum, rthr, noiseTab = null, rollAt = 0, rolls = 0, bgDirty = true;
    const clock0 = performance.now();
    let startTime = null, running = true, ready = false, frozen = false;
    // held until play(): the background shows, the subject waits at t = 0, which
    // with a fade-in means unseen, and the loop idles like a finished animation
    let waiting = o.autoplay === false;
    // a destroyed instance must never draw again: remounting on the same canvas
    // would otherwise leave the old loop painting over the new one
    let destroyed = false;
    let sceneCache = null;

    const art = document.createElement('canvas');
    const artCtx = art.getContext('2d', { willReadFrequently: true });
    const dith = document.createElement('canvas');
    const dithCtx = dith.getContext('2d');

    const pointer = { x: 0, y: 0, active: false };
    const head = { x: 0, y: 0, placed: false };
    let prevHead = { x: 0, y: 0 };

    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---------- source ----------
    let media = null, mediaReady = false, mediaW = 0, mediaH = 0;

    function loadSource() {
      if (type === 'video') {
        const v = o.src instanceof HTMLVideoElement ? o.src : Object.assign(document.createElement('video'), {
          src: o.src, muted: true, loop: !!o.loop, playsInline: true, preload: 'auto'
        });
        v.muted = true; v.playsInline = true;
        media = v;
        const go = () => {
          mediaW = v.videoWidth; mediaH = v.videoHeight;
          mediaReady = true; startTime = null; sceneCache = null;
          v.play().catch(() => {});
          resize(); if (o.onReady) o.onReady(api);
        };
        if (v.readyState >= 2) go(); else v.addEventListener('loadeddata', go, { once: true });
      } else {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          media = img;
          mediaW = o.sprite ? img.width / o.sprite.cols : img.width;
          mediaH = o.sprite ? img.height / o.sprite.rows : img.height;
          mediaReady = true; startTime = null; sceneCache = null;
          resize(); if (o.onReady) o.onReady(api);
        };
        img.src = o.src;
      }
    }

    const scaleOf = () => {
      const s = Math.min(W, H) * o.placement.size;
      return o.placement.designWidth ? s * Math.min(1, W / o.placement.designWidth) : s;
    };

    const aspect = () => (mediaH && mediaW ? mediaH / mediaW : 1);
    // the media's centre in CSS px, whatever edge it's anchored by
    const centreOf = () => {
      const dh = scaleOf() * aspect();
      const ay = o.placement.anchorY === undefined ? 0.5 : o.placement.anchorY;
      return { x: W * o.placement.x, y: H * o.placement.y + (0.5 - ay) * dh };
    };

    // ---------- setup ----------
    function resize() {
      if (destroyed) return;
      DPR = Math.min(devicePixelRatio || 1, 2);
      W = host.clientWidth; H = host.clientHeight;
      if (W < 1 || H < 1) { ready = false; return; }
      ready = true;

      cols = Math.ceil(W / BLOCK);
      rows = Math.ceil(H / BLOCK);

      // an exact integer multiple of the grid, so every cell lands on the same
      // number of device pixels and stays crisp
      canvas.width = cols * BLOCK * DPR;
      canvas.height = rows * BLOCK * DPR;
      canvas.style.width = (cols * BLOCK) + 'px';
      canvas.style.height = (rows * BLOCK) + 'px';
      ctx.imageSmoothingEnabled = false;

      art.width = cols; art.height = rows;
      dith.width = cols; dith.height = rows;
      outImage = dithCtx.createImageData(cols, rows);

      // fray: a random direction and reach per cell, seeded (README #3) so a resize
      // or a replay scatters the same way. Two numbers per cell: unit x, unit y
      // already scaled by a reach of 0.3–1.3× the push.
      frayDir = new Float32Array(cols * rows * 2);
      for (let i = 0; i < cols * rows; i++) {
        const a = rnd(i * 3.17 + 11.3) * Math.PI * 2, r = 0.3 + rnd(i * 5.71 + 2.9);
        frayDir[i * 2] = Math.cos(a) * r; frayDir[i * 2 + 1] = Math.sin(a) * r;
      }

      grain = new Float32Array(cols * rows);
      for (let i = 0; i < grain.length; i++) grain[i] = (rnd(i * 1.37 + 0.5) - 0.5) * o.grain;

      fx = new Float32Array(cols * rows);
      fy = new Float32Array(cols * rows);
      fieldLive = false;
      buildTurbulence();
      buildShape();
      L = new Float32Array(cols * rows);
      A = new Float32Array(cols * rows);
      const satN = (cols + 1) * (rows + 1);
      satL = new Float64Array(satN); satA = new Float64Array(satN); satB = new Float64Array(satN);
      buildBackground();
      sceneCache = null;
      render(now());
    }

    function now() {
      if (reduceMotion) return o.duration;
      if (waiting) return 0;
      if (startTime === null) return 0;
      const t = performance.now() - startTime;
      return o.loop ? (t % o.duration) : Math.min(t, o.duration);
    }

    // Per-cell shaping, evaluated once per resize. `shape(u, v)` receives
    // normalised coordinates over the drawn media (-1..1), and returns
    // { gain, hollow }. Multiplying luminance keeps true black at black.
    function buildShape() {
      gainMap = new Float32Array(cols * rows);
      hollowMap = new Float32Array(cols * rows);
      if (!o.shape) { gainMap.fill(1); return; }

      const dw = scaleOf();
      const dh = dw * aspect();
      const mc = centreOf(), cx = mc.x / BLOCK, cy = mc.y / BLOCK;
      const hw = (dw / 2) / BLOCK, hh = (dh / 2) / BLOCK;

      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const r = o.shape((x - cx) / hw, (y - cy) / hh) || {};
          const i = y * cols + x;
          gainMap[i] = r.gain === undefined ? 1 : r.gain;
          hollowMap[i] = r.hollow || 0;
        }
      }
    }

    // ---------- background ----------
    const B = () => o.background;
    const bgOn = () => { const b = B(); return b.gradient !== 'flat' || b.from > 0 || b.noise > 0; };
    const bgAnimated = () => !reduceMotion && bgOn() &&
      ((B().noise > 0 && B().speed > 0) || (B().pattern === 'random' && B().shimmer > 0));

    function buildBackground() {
      const b = B();
      gradMap = new Float32Array(cols * rows);
      bgLum = new Float32Array(cols * rows);
      rthr = new Float32Array(cols * rows);
      rolls = 0; rollRandom();

      // periodic lattice for value noise — seeded, so a resize keeps the pattern
      noiseTab = new Float32Array(256 * 256);
      for (let i = 0; i < noiseTab.length; i++) noiseTab[i] = rnd(i * 0.731 + b.seed * 17.3);

      const { x: cx, y: cy } = centreOf();
      const ang = (b.angle || 0) * Math.PI / 180, ux = Math.cos(ang), uy = Math.sin(ang);
      // project the corners so a linear ramp spans the whole stage at any angle
      const half = (Math.abs(ux) * W + Math.abs(uy) * H) / 2;
      const reach = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
      for (let y = 0; y < rows; y++) {
        const py = (y + 0.5) * BLOCK;
        for (let x = 0; x < cols; x++) {
          const px = (x + 0.5) * BLOCK;
          let t = 0;
          if (b.gradient === 'linear') t = clamp01(((px - W / 2) * ux + (py - H / 2) * uy) / (2 * half) + 0.5);
          else if (b.gradient === 'radial') t = clamp01(Math.hypot(px - cx, py - cy) / reach);
          gradMap[y * cols + x] = b.gradient === 'flat' ? b.from : b.from + (b.to - b.from) * t;
        }
      }
      bgDirty = true;
    }

    function rollRandom() {
      const seed = B().seed * 13.1 + rolls * 91.7;
      for (let i = 0; i < rthr.length; i++) rthr[i] = rnd(i * 1.37 + seed) * 255;
    }

    function vnoise(x, y) {
      const xi = Math.floor(x), yi = Math.floor(y);
      let tx = x - xi, ty = y - yi;
      tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const x0 = xi & 255, x1 = (xi + 1) & 255, y0 = (yi & 255) << 8, y1 = ((yi + 1) & 255) << 8;
      const a = noiseTab[y0 + x0], b = noiseTab[y0 + x1], c = noiseTab[y1 + x0], d = noiseTab[y1 + x1];
      const top = a + (b - a) * tx;
      return top + (c + (d - c) * tx - top) * ty;
    }

    // static backgrounds are computed once per resize; drifting ones every frame
    function updateBackground() {
      const b = B();
      const ms = performance.now() - clock0;
      if (b.pattern === 'random' && b.shimmer > 0 && !reduceMotion && ms >= rollAt) {
        rolls++; rollRandom(); rollAt = ms + 1000 / b.shimmer;
      }
      const drifting = b.noise > 0 && b.speed > 0 && !reduceMotion;
      if (!bgDirty && !drifting) return;
      bgDirty = false;

      const oct = Math.max(1, Math.min(5, b.octaves | 0));
      let norm = 0; for (let k = 0; k < oct; k++) norm += Math.pow(0.5, k);
      const f0 = BLOCK / Math.max(1, b.scale);
      const dx = drifting ? (ms / 1000) * b.speed / b.scale : 0;
      const dy = dx * 0.37;
      for (let y = 0, n = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++, n++) {
          let v = gradMap[n];
          if (b.noise > 0) {
            let sum = 0, amp = 1, f = f0, ox = dx, oy = dy;
            for (let k = 0; k < oct; k++, amp *= 0.5, f *= 2, ox *= 2.1, oy *= 1.7) {
              sum += amp * vnoise(x * f + ox + k * 31.7, y * f + oy + k * 17.3);
            }
            v += b.noise * (sum / norm - 0.5) * 2;
          }
          bgLum[n] = (v < 0 ? 0 : v > 1 ? 1 : v) * 255;
        }
      }
    }

    // ---------- draw the source frame ----------
    function drawScene(t) {
      const a = artCtx;
      a.setTransform(1, 0, 0, 1, 0, 0);
      // clear, not black: transparency is what lets the background sit behind
      a.clearRect(0, 0, cols, rows);
      if (!mediaReady) return;

      const dw = scaleOf();
      const dh = dw * (mediaH / mediaW);
      const mc = centreOf();
      const x = mc.x - dw / 2;
      const y = mc.y - dh / 2;

      a.setTransform(1 / BLOCK, 0, 0, 1 / BLOCK, 0, 0);
      a.globalAlpha = o.fadeIn ? Math.min(1, t / o.fadeIn) : 1;

      if (type === 'sprite') {
        const { frames, cols: gc } = o.sprite;
        const f = clamp01(t / o.duration) * (frames - 1);
        const i0 = Math.min(frames - 1, Math.floor(f));
        const i1 = Math.min(frames - 1, i0 + 1);
        const mix = f - i0;
        if (mix > 0.001 && i1 !== i0) {
          // cross-fade: a sprite sheet is usually too few frames to look smooth,
          // and the blend dithers into a clean tween. It must be a true mix —
          // (1−m)·A + m·B, added with 'lighter' — not B drawn over A at opacity m:
          // over-compositing thickens semi-transparent edges mid-blend, so a
          // transparent subject's outline shimmers even between identical frames.
          const base = a.globalAlpha;
          a.globalCompositeOperation = 'lighter';
          a.globalAlpha = base * (1 - mix);
          blit(a, i0, gc, mediaW, mediaH, x, y, dw, dh);
          a.globalAlpha = base * mix;
          blit(a, i1, gc, mediaW, mediaH, x, y, dw, dh);
          a.globalCompositeOperation = 'source-over';
        } else {
          blit(a, i0, gc, mediaW, mediaH, x, y, dw, dh);
        }
      } else {
        a.drawImage(media, x, y, dw, dh);
      }
      a.globalAlpha = 1;
    }

    function blit(c, idx, gc, fw, fh, x, y, w, h) {
      c.drawImage(media, (idx % gc) * fw, Math.floor(idx / gc) * fh, fw, fh, x, y, w, h);
    }

    // ---------- cursor smear ----------
    function buildTurbulence() {
      const step = 9;
      const nw = Math.ceil(cols / step) + 2, nh = Math.ceil(rows / step) + 2;
      const base = new Float32Array(nw * nh);
      for (let i = 0; i < base.length; i++) base[i] = rnd(i * 2.17 + 3.1);

      turb = new Float32Array(cols * rows);
      for (let y = 0; y < rows; y++) {
        const gy = y / step, y0 = gy | 0, ty = gy - y0, sy = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < cols; x++) {
          const gx = x / step, x0 = gx | 0, tx = gx - x0, sx = tx * tx * (3 - 2 * tx);
          const A = base[y0 * nw + x0], B = base[y0 * nw + x0 + 1];
          const C = base[(y0 + 1) * nw + x0], D = base[(y0 + 1) * nw + x0 + 1];
          const top = A + (B - A) * sx;
          turb[y * cols + x] = top + ((C + (D - C) * sx) - top) * sy;
        }
      }
    }

    function stirField(hx, hy, vx, vy) {
      const cur = o.cursor;
      const R = (cur.radius * Math.min(W, H)) / BLOCK;
      const cap = cur.max / BLOCK;
      const cxc = hx / BLOCK, cyc = hy / BLOCK;
      const vxc = (vx / BLOCK) * cur.strength, vyc = (vy / BLOCK) * cur.strength;

      const x0 = Math.max(0, Math.floor(cxc - R)), x1 = Math.min(cols - 1, Math.ceil(cxc + R));
      const y0 = Math.max(0, Math.floor(cyc - R)), y1 = Math.min(rows - 1, Math.ceil(cyc + R));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cxc, dy = y - cyc;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d >= R) continue;
          const f = 1 - d / R;
          const i = y * cols + x;
          // smooth turbulence, so the smear pulls into filaments rather than
          // tearing the image into hard stripes the way white noise would
          const w = f * f * (0.35 + turb[i] * 1.30);
          fx[i] = Math.max(-cap, Math.min(cap, fx[i] + vxc * w));
          fy[i] = Math.max(-cap, Math.min(cap, fy[i] + vyc * w));
        }
      }
      fieldLive = true;
    }

    function decayField() {
      if (!fieldLive) return false;
      const k = o.cursor.dissipation;
      let live = false;
      for (let i = 0; i < fx.length; i++) {
        const a = fx[i] * k, b = fy[i] * k;
        // snap to zero so the settled frame is identical to the untouched one
        fx[i] = Math.abs(a) < 0.02 ? 0 : a;
        fy[i] = Math.abs(b) < 0.02 ? 0 : b;
        if (fx[i] !== 0 || fy[i] !== 0) live = true;
      }
      fieldLive = live;
      return live;
    }

    function moveHead() {
      if (!pointer.active) return;
      if (!head.placed) { head.x = pointer.x; head.y = pointer.y; head.placed = true; }
      const dx = pointer.x - head.x, dy = pointer.y - head.y;
      // the chase is exponential and never quite arrives; snapping the last half
      // pixel is what lets a parked cursor go quiet
      if (dx * dx + dy * dy < 0.25) { head.x = pointer.x; head.y = pointer.y; return; }
      head.x += dx * o.cursor.drag;
      head.y += dy * o.cursor.drag;
    }

    // ---------- smear blur ----------
    // A summed-area table gives the mean of any box in four lookups, so every
    // smeared cell can have its own blur radius at a flat per-cell cost.
    function buildSAT(src, sat) {
      const w1 = cols + 1;
      for (let y = 0; y < rows; y++) {
        let row = 0;
        for (let x = 0; x < cols; x++) {
          row += src[y * cols + x];
          sat[(y + 1) * w1 + x + 1] = sat[y * w1 + x + 1] + row;
        }
      }
    }
    function boxMean(sat, cx, cy, r) {
      const w1 = cols + 1;
      const x0 = cx - r < 0 ? 0 : cx - r, x1 = cx + r >= cols ? cols - 1 : cx + r;
      const y0 = cy - r < 0 ? 0 : cy - r, y1 = cy + r >= rows ? rows - 1 : cy + r;
      const sum = sat[(y1 + 1) * w1 + x1 + 1] - sat[y0 * w1 + x1 + 1]
                - sat[(y1 + 1) * w1 + x0] + sat[y0 * w1 + x0];
      return sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
    // blend between the two nearest integer radii (radius 0 being the sharp
    // value), so the blur shrinks smoothly as the smear decays instead of stepping
    function blurred(sat, cx, cy, r, sharp) {
      const r0 = r | 0, f = r - r0;
      const a = r0 === 0 ? sharp : boxMean(sat, cx, cy, r0);
      return a + (boxMean(sat, cx, cy, r0 + 1) - a) * f;
    }

    // ---------- warp + threshold + present ----------
    function render(t) {
      if (sceneCache) {
        artCtx.setTransform(1, 0, 0, 1, 0, 0);
        artCtx.clearRect(0, 0, cols, rows);
        artCtx.drawImage(sceneCache, 0, 0);
      } else {
        drawScene(t);
        if (canFreeze() && t >= o.duration && mediaReady) {
          sceneCache = document.createElement('canvas');
          sceneCache.width = cols; sceneCache.height = rows;
          sceneCache.getContext('2d').drawImage(art, 0, 0);
        }
      }

      const src = artCtx.getImageData(0, 0, cols, rows).data;
      for (let n = 0, j = 0; n < L.length; n++, j += 4) {
        const al = src[j + 3] / 255;
        A[n] = al;
        // luma rather than the red channel, so colour sources dither by brightness
        L[n] = (src[j] * 0.299 + src[j + 1] * 0.587 + src[j + 2] * 0.114) * al;
      }
      const useBg = bgOn();
      if (useBg) updateBackground();
      const bgo = B();
      const lighten = bgo.blend === 'lighten', scatter = useBg && bgo.pattern === 'random';

      const blur = fieldLive ? (o.cursor.blur || 0) : 0;
      const fray = fieldLive ? (o.cursor.fray || 0) : 0;
      // the dust shimmers: every few frames each cell borrows another cell's
      // direction, so loose dots jitter rather than sitting frozen in place
      const shift = fray ? ((++frayTick >> 2) * 7919) % (cols * rows) : 0;
      if (blur > 0) {
        buildSAT(L, satL); buildSAT(A, satA);
        if (useBg) buildSAT(bgLum, satB);
      }

      const out = outImage.data;
      let i = 0, n = 0;
      for (let y = 0; y < rows; y++) {
        const trow = (y & 3) * 4;
        for (let x = 0; x < cols; x++, i += 4, n++) {
          let sx = x, sy = y;
          if (fieldLive) {
            // sample backwards along the field, so the image drags with the cursor
            let ox = fx[n], oy = fy[n];
            if (fray && (ox !== 0 || oy !== 0)) {
              // fray: part of the push stays a drift along the cursor, the rest is
              // thrown in a random direction — dots land outside the edge, holes
              // open inside. Scaled by the push, so it heals as the field decays.
              // dust only travels a short way, however hard the drag: capped, a big
              // push still drags the image while its edges crumble, instead of a
              // whole patch dissolving into sparse dots
              const m = Math.min(Math.sqrt(ox * ox + oy * oy) * 1.6, FRAY_REACH / BLOCK);
              const q = ((n + shift) % (cols * rows)) * 2;
              ox = ox * (1 - fray * 0.7) + frayDir[q] * m * fray;
              oy = oy * (1 - fray * 0.7) + frayDir[q + 1] * m * fray;
            }
            sx = (x - ox + 0.5) | 0;
            sy = (y - oy + 0.5) | 0;
            if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) sx = -1;
          }
          const p = sx < 0 ? -1 : sy * cols + sx;
          let s = p < 0 ? 0 : L[p];
          let al = p < 0 ? 0 : A[p];
          let bgv = useBg ? bgLum[p < 0 ? n : p] : 0;

          if (blur > 0 && p >= 0) {
            // soften in every direction, by as much as this cell was pushed. Blurring
            // along the drag alone does nothing visible: the smear already streaks
            // that way. It fades out with the field, so the settled frame is exact.
            const r = Math.min(32, blur * Math.sqrt(fx[n] * fx[n] + fy[n] * fy[n]));
            if (r > 0.05) {
              s = blurred(satL, sx, sy, r, s);
              al = blurred(satA, sx, sy, r, al);
              if (useBg) bgv = blurred(satB, sx, sy, r, bgv);
            }
          }

          const h = hollowMap[n];
          if (h > 0 && s > 0 && p >= 0) {
            // local gradient: flat interior reads ~0, a rim or fold reads high.
            // Keeping edges is what lets a shape survive being emptied out.
            const xm = sx > 0 ? sx - 1 : sx, xp = sx < cols - 1 ? sx + 1 : sx;
            const ym = sy > 0 ? sy - 1 : sy, yp = sy < rows - 1 ? sy + 1 : sy;
            const e = Math.abs(L[sy * cols + xp] - L[sy * cols + xm])
                    + Math.abs(L[yp * cols + sx] - L[ym * cols + sx]);
            s *= 1 - h * (1 - Math.min(1, e / o.edgeRef));
          }
          s = LUT[s | 0] * gainMap[n];   // LUT is integer-indexed

          let th = TH[trow + (x & 3)], g = grain[n];
          if (useBg) {
            // the background smears with the subject, so it was sampled at the same spot
            s = lighten ? Math.max(s, bgv) : s + bgv * (1 - al);
            // random thresholds only where the background shows, so the subject
            // keeps its ordered texture and the field around it goes grainy
            if (scatter && (lighten ? bgv >= s : al < 0.5)) { th = rthr[n]; g = 0; }
          }
          const on = (s < 4 ? s : s + g) > th ? INK : PAPER;
          out[i] = on[0]; out[i + 1] = on[1]; out[i + 2] = on[2]; out[i + 3] = 255;
        }
      }
      dithCtx.putImageData(outImage, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(dith, 0, 0, cols, rows, 0, 0, canvas.width, canvas.height);
    }

    // video and looping sources never settle, so they never freeze
    const canFreeze = () => type !== 'video' && !o.loop && !bgAnimated();

    // ---------- loop ----------
    function frame() {
      if (destroyed) return;
      if (!ready) { resize(); if (!ready) { requestAnimationFrame(frame); return; } }
      if (!mediaReady) { requestAnimationFrame(frame); return; }
      if (startTime === null && !waiting) startTime = performance.now();
      const t = now();

      if (o.cursor.enabled) {
        moveHead();
        const hvx = head.x - prevHead.x, hvy = head.y - prevHead.y;
        prevHead.x = head.x; prevHead.y = head.y;
        if (pointer.active && head.placed && (hvx * hvx + hvy * hvy) > 0.04) {
          stirField(head.x, head.y, hvx, hvy);
        }
      }
      const smearing = o.cursor.enabled ? decayField() : false;
      const live = !waiting && (!canFreeze() || t < o.duration);

      // the extra frame after everything settles is what wipes the last smear
      if (live || smearing || hadMotion) render(t);
      hadMotion = smearing;
      if (!live) frozen = true;

      if (!live && !smearing) { running = false; return; }
      requestAnimationFrame(frame);
    }

    function wake() { if (!running && !destroyed) { running = true; requestAnimationFrame(frame); } }

    // ---------- interaction ----------
    function setPointer(cx, cy) {
      const r = host.getBoundingClientRect();
      pointer.x = cx - r.left; pointer.y = cy - r.top;
      pointer.active = true; wake();
    }
    const onMove = (e) => setPointer(e.clientX, e.clientY);
    const onLeave = () => { pointer.active = false; head.placed = false; };
    const onTouch = (e) => { const t = e.touches[0]; if (t) setPointer(t.clientX, t.clientY); };

    if (o.cursor.enabled) {
      host.addEventListener('mousemove', onMove);
      host.addEventListener('mouseleave', onLeave);
      host.addEventListener('touchmove', onTouch, { passive: true });
    }
    const ro = new ResizeObserver(() => { resize(); wake(); });
    ro.observe(host);

    loadSource();
    resize();
    requestAnimationFrame(frame);

    const api = {
      replay() { waiting = false; startTime = performance.now(); sceneCache = null; frozen = false; wake(); },
      // start a mount made with autoplay: false (does nothing if already playing)
      play() { if (!waiting) return; waiting = false; startTime = null; sceneCache = null; frozen = false; wake(); },
      get waiting() { return waiting; },
      setSource(src, spriteOpts) {
        o.src = src; if (spriteOpts !== undefined) o.sprite = spriteOpts;
        mediaReady = false; sceneCache = null; loadSource(); wake();
      },
      set(patch) { Object.assign(o, deepMerge(o, patch)); sceneCache = null; resize(); wake(); },
      get frozen() { return frozen; },
      get options() { return o; },
      destroy() {
        destroyed = true; running = false; ro.disconnect();
        // a video we created would otherwise keep decoding after we're gone
        if (media instanceof HTMLVideoElement && media !== o.src) media.pause();
        host.removeEventListener('mousemove', onMove);
        host.removeEventListener('mouseleave', onLeave);
        host.removeEventListener('touchmove', onTouch);
      }
    };
    return api;
  }

  global.DitherFilter = { mount, DEFAULTS };
})(window);
