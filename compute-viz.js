// compute-viz: two isometric scenes drawn on one 1080x1080 canvas, driven only by data.json and a clock.
//   burst  : per-step CPU and memory bars; a resource-bound step turns orange and gets more cores or memory.
//   router : CI jobs routed to the provider where they finish fastest; an outage turns a provider orange and the
//            routing weights move to the others; telemetry scrolls on the right.
// Live: requestAnimationFrame. Film: ?rec=burst|router exposes REC_READY() and REC_STEP(t) for a frame-exact recorder.
// MIT. Inspired by a post of @dbworku; original code and data.
(() => {
  const W = 1080, H = 1080;
  const C = {
    bg: "#06080b", board: "#0d1219", boardEdge: "#2a3442", face: "#141b25", side: "#0b1017", edge: "#4a5668",
    ghost: "#1c2430", fg: "#f2f4f7", dim: "#8a93a3", teal: "#2fd1b2", tealDim: "#1a6f62", orange: "#f2a33a", white: "#ffffff",
  };
  const SANS = "Inter, sans-serif", MONO = "'IBM Plex Mono', ui-monospace, monospace";
  const q = new URLSearchParams(location.search);
  const cv = document.getElementById("c"), g = cv.getContext("2d");
  let D = null, scene = q.get("rec") || q.get("scene") || "burst", T0 = performance.now();

  function fit() {
    const dpr = window.devicePixelRatio || 1, s = Math.min(innerWidth / W, innerHeight / H);
    cv.width = Math.round(W * s * dpr); cv.height = Math.round(H * s * dpr);
    cv.style.width = W * s + "px"; cv.style.height = H * s + "px";
    cv.style.margin = `${(innerHeight - H * s) / 2}px auto 0`;
    g.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
  }

  // ---------- helpers ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (t) => t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function noise1(seed, n) { const r = rng(seed), a = []; let v = 0; for (let i = 0; i < n; i++) { v = v * 0.6 + (r() - 0.5) * 0.8; a.push(v); } return a; }
  function text(s, x, y, o = {}) {
    g.font = `${o.w || 500} ${o.size || 30}px ${o.mono ? MONO : SANS}`;
    g.fillStyle = o.color || C.fg; g.textAlign = o.align || "left"; g.textBaseline = o.base || "alphabetic";
    g.globalAlpha = o.alpha ?? 1; g.fillText(s, x, y); g.globalAlpha = 1;
  }
  function glow(color, blur, fn) { g.save(); g.shadowColor = color; g.shadowBlur = blur; fn(); g.restore(); }

  // isometric projection: x to the right-down, y to the left-down, z up (board units are pixels before scale)
  function isoMaker(ox, oy, k = 1, tilt = 0.5) {
    const a = Math.cos(Math.PI / 6) * k, b = tilt * k;
    return (x, y, z = 0) => [ox + (x - y) * a, oy + (x + y) * b - z * k];
  }
  function poly(pts, fill, stroke, lw = 1.2, alpha = 1) {
    g.globalAlpha = alpha; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
    g.globalAlpha = 1;
  }
  // a box on the iso grid: x,y = back corner, w along x, d along y, h up
  function box(P, x, y, w, d, h, top, side, front, stroke, alpha = 1) {
    const p = (a, b, c) => P(a, b, c);
    poly([p(x, y + d, 0), p(x + w, y + d, 0), p(x + w, y + d, h), p(x, y + d, h)], front, stroke, 1, alpha);   // front-left face
    poly([p(x + w, y, 0), p(x + w, y + d, 0), p(x + w, y + d, h), p(x + w, y, h)], side, stroke, 1, alpha);    // front-right face
    poly([p(x, y, h), p(x + w, y, h), p(x + w, y + d, h), p(x, y + d, h)], top, stroke, 1, alpha);              // top
  }
  function slab(P, x, y, w, d, h) {
    box(P, x, y, w, d, h, C.board, "#080c11", "#0a0e14", C.boardEdge);
  }
  function header(sc, t) {
    const a = ease(t / 0.6);
    text(sc.label, 72, 104, { size: 30, mono: true, color: C.teal, alpha: a });
    text(sc.headline, 72, 164, { size: 42, w: 600, alpha: a });
  }
  function legend(items, status, t) {
    let x = 72; const y = 1004;
    for (const [col, name, round] of items) {
      g.fillStyle = col;
      if (round) { g.beginPath(); g.arc(x + 11, y - 10, 9, 0, 7); g.fill(); } else g.fillRect(x, y - 21, 26, 22);
      text(name, x + 42, y, { size: 30, mono: true, color: C.dim }); g.font = `500 30px ${MONO}`; x += 42 + g.measureText(name).width + 40;
    }
    if (status) text(status, 72, 1056, { size: 30, mono: true, color: C.fg, alpha: 0.9 });
  }

  // ---------- scene: burst ----------
  function burstModel(sc) {
    const cols = sc.cols, stepOf = (c) => sc.steps.find((s) => c >= s.from && c < s.to) || sc.steps[sc.steps.length - 1];
    const nz = noise1(7, cols), nm = noise1(11, cols), cores = [], mem = [], extraCpu = [], extraMem = [];
    let cpuCap = sc.cpu.base, memCap = sc.mem.base;
    for (let c = 0; c < cols; c++) {
      const st = stepOf(c);
      for (const b of sc.bursts) if (b.at === c) { if (b.cpu) cpuCap += b.cpu; if (b.mem) memCap += b.mem; }
      const needCpu = clamp(st.cpu + nz[c] * 0.12, 0.05, 1.4) * sc.cpu.base;    // in cores
      const needMem = clamp(st.mem + nm[c] * 0.08, 0.05, 1.4) * sc.mem.base;    // in GB
      cores.push({ need: needCpu, cap: cpuCap }); mem.push({ need: needMem, cap: memCap });
      extraCpu.push(cpuCap - sc.cpu.base); extraMem.push(memCap - sc.mem.base);
    }
    return { cols, stepOf, cores, mem, extraCpu, extraMem };
  }

  function drawBurst(t) {
    const sc = D.burst, M = burstModel(sc), dur = sc.seconds;
    const now = Math.floor(clamp((t - 0.8) / (dur - 2.2), 0, 1) * (M.cols - 1));
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    header(sc, t);
    const cw = 15, rowD = 44, maxRows = sc.cpu.max + 1, boardW = M.cols * cw + 90, boardD = maxRows * rowD + 150;
    // centre the board: its middle (x0+w/2, y0+d/2) lands at (540, 600)
    const bx0 = -40, by0 = -30, mx = bx0 + boardW / 2, my = by0 + boardD / 2, sk = 0.8;
    const P = isoMaker(540 - (mx - my) * 0.866 * sk, 610 - (mx + my) * 0.5 * sk, sk, 0.5);
    slab(P, bx0, by0, boardW, boardD, 16);
    g.save(); g.translate(0, -16);
    // step ticks along the front edge
    for (const st of sc.steps) {
      const yb = maxRows * rowD + 16, [x0, y0] = P(st.from * cw, yb), [x1, y1] = P(st.to * cw, yb);
      g.strokeStyle = C.ghost; g.lineWidth = 2; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      const active = now >= st.from && now < st.to || (st === sc.steps[sc.steps.length - 1] && now >= st.to - 1);
      const [lx, ly] = P(st.from * cw + 20, yb + 96);
      g.fillStyle = active ? C.fg : C.dim; g.beginPath(); g.arc(lx - 10, ly - 10, 4, 0, 7); g.fill();
      text(st.name, lx, ly, { size: 30, mono: true, color: active ? C.fg : C.dim });
    }
    // rows: 0 = memory (back), 1..n = vCPU
    const rows = [{ kind: "mem" }]; for (let i = 0; i < sc.cpu.max; i++) rows.push({ kind: "cpu", core: i });
    const cellsH = 150;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r], y = r * rowD;
      for (let c = 0; c < M.cols; c++) {
        const x = c * cw, future = c > now;
        let cap, util, bound, exists = true;
        if (row.kind === "mem") { const m = M.mem[c]; cap = m.cap; util = Math.min(m.need, m.cap) / m.cap; bound = m.need > m.cap * 0.97; }
        else {
          const k = M.cores[c]; cap = k.cap; exists = row.core < k.cap;
          const per = k.need / k.cap; util = clamp(per * (1 + (((row.core * 37 + c * 13) % 9) - 4) * 0.03), 0, 1); bound = k.need > k.cap * 0.97;
        }
        if (!exists) { if (!future) box(P, x, y, cw * 0.72, rowD * 0.55, 3, C.ghost, C.ghost, C.ghost, null, 0.5); continue; }
        const h = Math.max(3, util * cellsH);
        if (future) { box(P, x, y, cw * 0.72, rowD * 0.55, 3, C.ghost, C.ghost, C.ghost, null, 0.6); continue; }
        const isNow = c === now, age = now - c;
        if (isNow || (age < 3 && bound)) {
          const col = bound ? C.orange : C.teal;
          glow(col, 18, () => box(P, x, y, cw * 0.72, rowD * 0.55, h, col, shade(col, 0.55), shade(col, 0.75), shade(col, 1.2)));
        } else box(P, x, y, cw * 0.72, rowD * 0.55, h, C.face, C.side, "#10161f", C.edge, clamp(1 - age / (M.cols * 1.2), 0.35, 1));
      }
      // row label at the left end
      const [lx, ly] = P(-46, y + 10);
      const born = row.kind === "cpu" && row.core >= sc.cpu.base ? M.cores[now].cap > row.core : true;
      if (r === 0) text("Memory", lx - 12, ly - 40, { size: 32, w: 600, align: "right" });
      if (r === 2) text("vCPU", lx - 12, ly + 4, { size: 32, w: 600, align: "right" });
      if (row.kind === "cpu" && !born) continue;
    }
    // callouts when a burst lands
    for (const b of sc.bursts) {
      const since = now - b.at; if (since < 0) continue;
      const a = ease(since / 3) * (since > 14 ? ease((22 - since) / 8) : 1); if (a <= 0) continue;
      const r = b.cpu ? sc.cpu.base + 1 : 0, [px, py] = P(b.at * cw, r * rowD, b.cpu ? 90 : 160), lbl = b.cpu ? `+${b.cpu} vCPU` : `+${b.mem} GB`;
      g.globalAlpha = a; g.strokeStyle = C.teal; g.lineWidth = 2; g.beginPath(); g.moveTo(px, py); g.lineTo(px, py - 120); g.lineTo(px + 22, py - 120); g.stroke();
      g.fillStyle = C.teal; g.beginPath(); g.arc(px, py, 5, 0, 7); g.fill(); g.globalAlpha = 1;
      text(lbl, px + 30, py - 110, { size: 32, mono: true, color: C.teal, alpha: a });
    }
    g.restore();
    // live readout
    const st = M.stepOf(now), k = M.cores[now], m = M.mem[now];
    legend([[C.teal, "Utilisation"], [C.orange, "Resource-bound"]],
      `now  ${st.name} · ${k.cap} vCPU · ${Math.min(m.need, m.cap).toFixed(1)}/${m.cap} GB`, t);
  }
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255, m = (v) => clamp(Math.round(v * f), 0, 255);
    return `rgb(${m(r)},${m(gg)},${m(b)})`;
  }

  // ---------- scene: router ----------
  function drawRouter(t) {
    const sc = D.router, dur = sc.seconds;
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    header(sc, t);
    poly([[48, 290], [1032, 290], [1032, 880], [48, 880]], "#0a0f15", "#1d2530", 1.4);
    // column titles
    const cols = [["Jobs", 230], ["Providers", 580], ["End to end", 860]];
    for (const [s, x] of cols) text(s, x, 262, { size: 32, w: 600, align: "center", alpha: ease(t / 0.8) });
    // outage state per provider
    const down = sc.providers.map((p) => p.down && t >= p.down[0] && t < p.down[1]);
    const downAmt = sc.providers.map((p) => !p.down ? 0 : ease((t - p.down[0]) / 0.6) * (1 - ease((t - p.down[1]) / 0.6)));
    // routing weights: softmax of speed, minus outage; smoothed by evaluating at t
    const jobs = sc.jobs, J = jobs.length, PN = sc.providers.length;
    const jy = (j) => 345 + j * 98, px = 580, py = (p) => 360 + p * 140;
    const weights = jobs.map((job, j) => {
      const w = sc.providers.map((p, i) => Math.exp(-p.cost[j % p.cost.length] / 1.2) * (1 - downAmt[i] * 0.98));
      const s = w.reduce((a, b) => a + b, 0); return w.map((v) => v / s);
    });
    // curves
    for (let j = 0; j < J; j++) for (let i = 0; i < PN; i++) {
      const w = weights[j][i], x0 = 376, y0 = jy(j), x1 = px - 52, y1 = py(i);
      g.strokeStyle = w > 0.08 ? C.teal : "#2a3240"; g.globalAlpha = w > 0.08 ? 0.25 + w * 0.75 : 0.5; g.lineWidth = w > 0.08 ? 1.5 + w * 5 : 1;
      g.beginPath(); g.moveTo(x0, y0); g.bezierCurveTo(x0 + 90, y0, x1 - 90, y1, x1, y1);
      if (w > 0.3) glow(C.teal, 12, () => g.stroke()); else g.stroke();
      g.globalAlpha = 1;
      // telemetry dots riding the busy curves
      if (w > 0.25) {
        const u = ((t * 0.55 + j * 0.17 + i * 0.29) % 1), bx = bez(x0, x0 + 90, x1 - 90, x1, u), by = bez(y0, y0, y1, y1, u);
        glow(C.white, 10, () => { g.fillStyle = C.white; g.beginPath(); g.arc(bx, by, 4, 0, 7); g.fill(); });
      }
    }
    // jobs
    for (let j = 0; j < J; j++) {
      const y = jy(j), lit = (Math.floor(t * 2) + j) % J === 0;
      poly([[296, y - 22], [376, y - 22], [376, y + 22], [296, y + 22]], "#121822", C.edge, 1.4);
      g.fillStyle = lit ? C.teal : C.tealDim; g.beginPath(); g.arc(336, y, 9, 0, 7); g.fill();
      text(jobs[j], 280, y + 10, { size: 30, mono: true, align: "right", color: C.fg });
    }
    // providers as dials
    for (let i = 0; i < PN; i++) {
      const y = py(i), load = weights.reduce((a, w) => a + w[i], 0) / J, d = downAmt[i];
      g.fillStyle = "#0e141c"; g.strokeStyle = d > 0.5 ? C.orange : C.edge; g.lineWidth = 2;
      g.beginPath(); g.ellipse(px, y, 50, 44, 0, 0, 7); g.fill(); g.stroke();
      for (let k = 0; k < 12; k++) { const a = -Math.PI * 0.75 + (k / 11) * Math.PI * 1.5; g.strokeStyle = C.dim; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px + Math.sin(a) * 36, y - Math.cos(a) * 32); g.lineTo(px + Math.sin(a) * 42, y - Math.cos(a) * 38); g.stroke(); }
      const ang = -Math.PI * 0.75 + clamp(load * 2.2 + Math.sin(t * 3 + i) * 0.03, 0, 1) * Math.PI * 1.5;
      g.strokeStyle = C.white; g.lineWidth = 3; g.beginPath(); g.moveTo(px, y); g.lineTo(px + Math.sin(ang) * 34, y - Math.cos(ang) * 30); g.stroke();
      const ring = d > 0.05 ? C.orange : load > 0.15 ? C.teal : C.tealDim;
      glow(ring, d > 0.05 || load > 0.15 ? 14 : 0, () => { g.strokeStyle = ring; g.lineWidth = 5; g.beginPath(); g.ellipse(px, y + 50, 44, 9, 0, 0, 7); g.stroke(); });
      text(sc.providers[i].name, px + 70, y + 12, { size: 34, w: 600, color: d > 0.5 ? C.orange : C.fg });
    }
    // telemetry panel
    const fx = 700, fw = 312;
    poly([[fx, 310], [fx + fw, 310], [fx + fw, 470], [fx, 470]], "#0c1118", C.edge, 1.4);
    // end-to-end minutes falls as the router learns, bumps during the outage
    const e2e = (u) => { const base = lerp(sc.e2e[0], sc.e2e[1], ease(u / dur * 1.4)); const bump = sc.providers.reduce((a, p) => a + (!p.down ? 0 : Math.exp(-((u - p.down[0] - 0.8) ** 2) / 0.6) * 4), 0); return base + bump; };
    const mapY = (m) => 450 - (m - sc.e2e[1] + 2) / (sc.e2e[0] - sc.e2e[1] + 4) * 130;
    g.strokeStyle = C.white; g.lineWidth = 2.5; g.beginPath();
    for (let k = 0; k <= 60; k++) { const u = t - (60 - k) * 0.12, x = fx + 14 + k * ((fw - 28) / 60), y = mapY(e2e(Math.max(0, u))); k ? g.lineTo(x, y) : g.moveTo(x, y); }
    glow(C.white, 8, () => g.stroke());
    text(`${e2e(t).toFixed(0)} min`, fx + fw - 14, 338, { size: 32, mono: true, align: "right", color: C.teal });
    // three telemetry strips
    sc.telemetry.forEach((tm, k) => {
      const y0 = 500 + k * 124, nz = noise1(31 + k, 400), spike = (u) => (tm.spikes ? (Math.sin(u * 7 + k) > 0.93 ? 1 : 0) : 0);
      poly([[fx, y0], [fx + fw, y0], [fx + fw, y0 + 100], [fx, y0 + 100]], "#0c1118", C.edge, 1.4);
      text(tm.name, fx + 14, y0 + 36, { size: 30, mono: true, color: C.dim });
      g.strokeStyle = C.fg; g.lineWidth = 1.8; g.beginPath();
      let last = 0;
      for (let s = 0; s <= 80; s++) {
        const u = t * 8 + s, v = nz[Math.floor(u) % 400] * 0.5 + spike(u / 8) * 1.6 + (down.some(Boolean) ? 0.6 : 0) * (tm.outage || 0);
        const x = fx + 14 + s * ((fw - 28) / 80), y = y0 + 80 - clamp(v + 0.5, 0, 2.2) * 16; s ? g.lineTo(x, y) : g.moveTo(x, y); last = v;
      }
      g.stroke();
      const val = tm.value[0] + (tm.value[1] - tm.value[0]) * clamp(last + 0.5, 0, 1);
      text(`${val.toFixed(tm.dp ?? 0)} ${tm.unit}`, fx + fw - 14, y0 + 36, { size: 30, mono: true, align: "right", color: C.teal });
    });
    const out = sc.providers.filter((p, i) => down[i]).map((p) => p.name);
    legend([[C.teal, "Routing weight"], [C.white, "Telemetry", true], [C.orange, "Outage"]],
      out.length ? `now  ${out.join(" + ")} down · rerouting` : `now  routing ${J} jobs`, t);
  }
  const bez = (a, b, c, d, u) => { const v = 1 - u; return v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * c + u * u * u * d; };

  // ---------- run ----------
  function frame(t) {
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); fit();
    (scene === "router" ? drawRouter : drawBurst)(t);
    if (D.credit) text(D.credit, W - 72, 1056, { size: 30, mono: true, color: C.dim, align: "right", alpha: 0.7 });
  }
  function loop() {
    const sc = D[scene], t = ((performance.now() - T0) / 1000) % sc.seconds;
    frame(t); requestAnimationFrame(loop);
  }
  if (!q.get("rec") && !q.get("scene")) setInterval(() => { scene = scene === "burst" ? "router" : "burst"; T0 = performance.now(); }, 1000 * 13);
  addEventListener("resize", fit);
  fetch(q.get("data") || "data.json").then((r) => r.json()).then(async (d) => {
    D = d;
    const faces = [["Inter", "fonts/Inter-Medium.ttf", "500"], ["Inter", "fonts/Inter-SemiBold.ttf", "600"],
      ["IBM Plex Mono", "fonts/IBMPlexMono-Regular.woff2", "500"]];
    await Promise.all(faces.map(([f, u, w]) => new FontFace(f, `url(${u})`, { weight: w }).load().then((ff) => document.fonts.add(ff)).catch(() => {})));
    fit();
    if (q.get("rec")) { window.REC_STEP = (t) => frame(t); window.REC_DURATION = D[scene].seconds; frame(0); window.REC_READY = () => true; }
    else loop();
  });
})();
