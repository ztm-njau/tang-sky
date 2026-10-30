// 唐詩星圖 应用逻辑
// 模块划分：boot(加载) → camera(视角/惯性) → pick(网格拾取) → reader(卷轴)
//   → search(检索) → filter(意象过滤) → labels(星团标注) → stamps(星印)
//   → constellation(连星成座/分享) → todayStar(今夜主星) → toast
'use strict';

(function () {
  // ---------- 小工具 ----------
  const $ = id => document.getElementById(id);
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function toast(msg) {
    const box = $('toast');
    while (box.children.length >= 2) box.removeChild(box.firstChild);
    const el = document.createElement('div');
    el.className = 'toast-item';
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function esc(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 全局状态 ----------
  const S = {
    meta: null,
    starCount: 0,
    positions: null,        // Float32Array N*2
    clusterOf: null,        // Uint16Array N
    famousOf: null,         // Uint8Array N
    neighbors: null,        // Uint16Array N*6
    texts: new Map(),       // id → {i,a,t,c,n}
    shardLoaded: new Array(12).fill(false),
    shardPending: new Map(),
    index: null,            // [{id,t,a,head}]
    grid: null, gridCell: 300,
    cam: { x: 0, y: 0, scale: 0.2 },
    camTarget: null,        // 飞行目标 {x,y,scale}
    initScale: 0.2,
    todayStarId: -1,
    stamps: new Set(),
    constStars: [],         // 连星模式选中的 id
    constMode: false,
    hovered: -1,
    currentReader: -1,
  };

  try {
    const saved = JSON.parse(localStorage.getItem('tangsky.stamps') || '[]');
    if (Array.isArray(saved)) S.stamps = new Set(saved.filter(v => Number.isInteger(v)));
  } catch (_) { /* 忽略坏数据 */ }

  // ---------- 数据加载 ----------
  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
    return r.json();
  }
  async function fetchBuf(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
    return r.arrayBuffer();
  }

  async function loadShard(sh) {
    if (S.shardLoaded[sh]) return;
    if (S.shardPending.has(sh)) return S.shardPending.get(sh);
    const p = fetchJSON(`data/texts/t${sh}.json`).then(arr => {
      for (const o of arr) S.texts.set(o.i, o);
      S.shardLoaded[sh] = true;
    });
    S.shardPending.set(sh, p);
    return p;
  }
  const shardOf = id => id % 12;

  async function loadIndex() {
    const r = await fetch('data/index.txt');
    const txt = await r.text();
    const lines = txt.split('\n');
    const idx = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const f = lines[i].split('\t');
      idx[f[0]] = { id: +f[0], t: f[1], a: f[2], head: f[3] || '' };
    }
    S.index = idx;
  }

  // ---------- 相机 ----------
  const canvas = $('sky');

  function screenToWorld(px, py) {
    return {
      x: S.cam.x + (px - innerWidth / 2) / S.cam.scale,
      y: S.cam.y - (py - innerHeight / 2) / S.cam.scale,
    };
  }
  function worldToScreen(wx, wy) {
    return {
      x: (wx - S.cam.x) * S.cam.scale + innerWidth / 2,
      y: innerHeight / 2 - (wy - S.cam.y) * S.cam.scale,
    };
  }

  function flyTo(x, y, scale) {
    S.camTarget = { x, y, scale: scale || S.cam.scale };
  }
  function flyToStar(id, scale) {
    const x = S.positions[id * 2], y = S.positions[id * 2 + 1];
    flyTo(x, y, scale || Math.max(S.initScale * 3.2, 0.5));
  }
  function stepCamera() {
    if (S.camTarget) {
      const t = S.camTarget, k = REDUCED ? 1 : 0.14;
      S.cam.x += (t.x - S.cam.x) * k;
      S.cam.y += (t.y - S.cam.y) * k;
      S.cam.scale += (t.scale - S.cam.scale) * k;
      if (Math.abs(t.x - S.cam.x) < 0.5 && Math.abs(t.y - S.cam.y) < 0.5 &&
          Math.abs(t.scale - S.cam.scale) / t.scale < 0.004) {
        S.cam = { ...t };
        S.camTarget = null;
      }
    } else if (drag.mode === 'inertia') {
      S.cam.x -= drag.vx / S.cam.scale;
      S.cam.y += drag.vy / S.cam.scale;
      drag.vx *= 0.94; drag.vy *= 0.94;
      if (Math.abs(drag.vx) < 0.02 && Math.abs(drag.vy) < 0.02) drag.mode = null;
    }
  }

  // ---------- 拖拽 / 缩放 ----------
  const drag = { mode: null, sx: 0, sy: 0, lx: 0, ly: 0, vx: 0, vy: 0, moved: false, pinch: 0 };

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    drag.mode = 'down'; drag.sx = drag.lx = e.clientX; drag.sy = drag.ly = e.clientY;
    drag.vx = drag.vy = 0; drag.moved = false;
    S.camTarget = null;
  });
  canvas.addEventListener('pointermove', e => {
    if (drag.mode === 'down' || drag.mode === 'drag') {
      const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
      drag.lx = e.clientX; drag.ly = e.clientY;
      if (drag.mode === 'down' && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.mode = 'drag';
      if (drag.mode === 'drag') {
        S.cam.x -= dx / S.cam.scale;
        S.cam.y += dy / S.cam.scale;
        drag.vx = dx; drag.vy = dy;
        drag.moved = true;
        canvas.classList.add('dragging');
      }
    }
    updateHover(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerup', e => {
    canvas.classList.remove('dragging');
    if (drag.mode === 'down' && !drag.moved) { clickEmpty(e.clientX, e.clientY); }
    else if (drag.mode === 'down' || drag.mode === 'drag') {
      // 点选判定：按住没怎么动 → 点击拾取
      if (drag.mode === 'down') { /* handled above */ }
      else if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) { clickEmpty(e.clientX, e.clientY); }
      else drag.mode = 'inertia';
    }
    if (drag.mode !== 'inertia') drag.mode = null;
  });
  canvas.addEventListener('pointercancel', () => { drag.mode = null; canvas.classList.remove('dragging'); });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    S.camTarget = null;
    const before = screenToWorld(e.clientX, e.clientY);
    S.cam.scale = clamp(S.cam.scale * Math.pow(1.0016, -e.deltaY), S.initScale * 0.55, S.initScale * 14);
    const after = screenToWorld(e.clientX, e.clientY);
    S.cam.x += before.x - after.x;
    S.cam.y += before.y - after.y;
  }, { passive: false });

  canvas.addEventListener('dblclick', e => {
    const w = screenToWorld(e.clientX, e.clientY);
    const id = pickStar(w.x, w.y);
    if (id >= 0) { flyToStar(id); openStar(id); }
  });

  // 双指捏合
  const touches = new Map();
  canvas.addEventListener('touchstart', e => {
    for (const t of e.changedTouches) touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      drag.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      drag.mode = 'pinch';
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) if (touches.has(t.identifier)) touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    if (drag.mode === 'pinch' && touches.size === 2) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (drag.pinch > 0) {
        S.cam.scale = clamp(S.cam.scale * (d / drag.pinch), S.initScale * 0.55, S.initScale * 14);
      }
      drag.pinch = d;
      e.preventDefault();
    }
  }, { passive: false });
  canvas.addEventListener('touchend', e => {
    for (const t of e.changedTouches) touches.delete(t.identifier);
    if (touches.size < 2 && drag.mode === 'pinch') drag.mode = null;
  });

  // ---------- 网格拾取 ----------
  function buildGrid() {
    const cell = S.gridCell;
    const g = new Map();
    for (let i = 0; i < S.starCount; i++) {
      const k = Math.floor(S.positions[i * 2] / cell) + ',' + Math.floor(S.positions[i * 2 + 1] / cell);
      let b = g.get(k);
      if (!b) { b = []; g.set(k, b); }
      b.push(i);
    }
    S.grid = g;
  }
  function pickStar(wx, wy) {
    if (!S.grid) return -1;
    const cell = S.gridCell, r = 14 / S.cam.scale;
    const gx = Math.floor(wx / cell), gy = Math.floor(wy / cell);
    let best = -1, bd = r * r;
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const b = S.grid.get((gx + ox) + ',' + (gy + oy));
      if (!b) continue;
      for (const i of b) {
        const dx = S.positions[i * 2] - wx, dy = S.positions[i * 2 + 1] - wy;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  }

  const tip = document.createElement('div');
  tip.id = 'starTip';
  tip.className = 'hidden';
  document.body.appendChild(tip);

  function updateHover(px, py) {
    if (S.constMode) { hideTip(); return; }
    const w = screenToWorld(px, py);
    const id = pickStar(w.x, w.y);
    if (id !== S.hovered) {
      S.hovered = id;
      canvas.classList.toggle('picking', id >= 0);
    }
    if (id >= 0) {
      const info = S.texts.get(id);
      const meta0 = S.index && S.index[id];
      const t = info ? info.t : (meta0 ? meta0.t : '…');
      const a = info ? info.a : (meta0 ? meta0.a : '');
      tip.innerHTML = esc(t) + (a ? `<span class="tip-a">${esc(a)}</span>` : '');
      tip.classList.remove('hidden');
      tip.style.left = Math.min(px + 14, innerWidth - 160) + 'px';
      tip.style.top = (py - 34) + 'px';
    } else hideTip();
  }
  function hideTip() { tip.classList.add('hidden'); }

  function clickEmpty(px, py) {
    const w = screenToWorld(px, py);
    const id = pickStar(w.x, w.y);
    if (id >= 0) {
      if (S.constMode) addConstStar(id);
      else openStar(id);
    }
  }

  // ---------- 渲染循环 ----------
  let renderer = null;
  let vertexData = null;

  function frame(now) {
    stepCamera();
    if (renderer) {
      const drift = $('intro') && !REDUCED ? 0.04 : 0; // 开场时缓慢漂移
      if (drift) S.cam.x += drift / S.cam.scale;
      renderer.render(S.cam, now / 1000, REDUCED ? 0 : 1);
    }
    drawLines();
    updateLabels();
    requestAnimationFrame(frame);
  }

  // ---------- 星团标注 ----------
  const labelsBox = $('labels');
  let labelEls = [];
  function buildLabels() {
    labelsBox.textContent = '';
    labelEls = S.meta.clusters.map(c => {
      const el = document.createElement('span');
      el.className = 'cl-label';
      el.textContent = c.name;
      el.title = c.tip + ' · ' + c.n + ' 首';
      el.style.opacity = '0';
      labelsBox.appendChild(el);
      return { el, c };
    });
  }
  function updateLabels() {
    if (!labelEls.length) return;
    const show = S.cam.scale > S.initScale * 1.05;
    for (const { el, c } of labelEls) {
      if (!show) { el.style.opacity = '0'; continue; }
      const p = worldToScreen(c.cx, c.cy);
      if (p.x < -60 || p.x > innerWidth + 60 || p.y < -60 || p.y > innerHeight + 60) {
        el.style.opacity = '0';
        continue;
      }
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%,-50%)`;
      el.style.opacity = '0.8';
    }
  }

  // ---------- 连线画布 ----------
  const linesCv = document.createElement('canvas');
  linesCv.id = 'lines';
  document.body.insertBefore(linesCv, labelsBox);
  const lctx = linesCv.getContext('2d');

  function resizeLines() {
    const dpr = devicePixelRatio || 1;
    linesCv.width = innerWidth * dpr;
    linesCv.height = innerHeight * dpr;
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawLines() {
    lctx.clearRect(0, 0, innerWidth, innerHeight);
    const pts = [];
    // 连星模式：当前星座
    if (S.constStars.length) {
      for (const id of S.constStars) pts.push([id, false]);
    }
    // 星印模式（无连线需求，仅 constStars）
    if (pts.length < 2) return;
    lctx.strokeStyle = 'rgba(212,176,106,0.55)';
    lctx.lineWidth = 1;
    lctx.beginPath();
    let started = false;
    for (const [id] of pts) {
      const p = worldToScreen(S.positions[id * 2], S.positions[id * 2 + 1]);
      if (!started) { lctx.moveTo(p.x, p.y); started = true; }
      else lctx.lineTo(p.x, p.y);
    }
    lctx.stroke();
    lctx.fillStyle = 'rgba(212,176,106,0.9)';
    for (const [id, hollow] of pts) {
      const p = worldToScreen(S.positions[id * 2], S.positions[id * 2 + 1]);
      lctx.beginPath();
      lctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      if (hollow) { lctx.strokeStyle = 'rgba(212,176,106,0.9)'; lctx.stroke(); }
      else lctx.fill();
    }
  }

  // ---------- Reader ----------
  const reader = $('reader');

  async function openStar(id) {
    S.currentReader = id;
    await loadShard(shardOf(id));
    if (S.currentReader !== id) return;
    const info = S.texts.get(id);
    if (!info) { toast('詩文載入失敗'); return; }
    const st = S.index ? S.index[id] : null;
    const isToday = id === S.todayStarId;

    $('rTitle').innerHTML = esc(info.t || st?.t || '無題') +
      ((S.famousOf && S.famousOf[id]) ? '<span class="famous-star">★</span>' : '');
    $('rAuthor').textContent = (info.a || st?.a || '佚名') + ' · 唐';
    const note = (isToday ? '今夜主星 · ' : '') + (info.n || '');
    const rNote = $('rNote');
    if (note.trim()) { rNote.textContent = note; rNote.classList.remove('hidden'); }
    else rNote.classList.add('hidden');

    const body = $('rBody');
    body.textContent = '';
    for (const line of info.c.split('\n')) {
      const p = document.createElement('p');
      p.textContent = line;
      body.appendChild(p);
    }
    body.scrollTop = 0;

    // 意象 chips
    const dimsBox = $('rDims');
    dimsBox.textContent = '';
    if (S.meta) {
      const dv = new DataView(starBinCache);
      const t1 = dv.getUint8(id * 16 + 12), t2 = dv.getUint8(id * 16 + 13);
      for (const d of [t1, t2]) {
        const dn = S.meta.dimNames[d];
        if (!dn) continue;
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = dn.name;
        chip.title = dn.tip;
        chip.style.borderColor = dn.color;
        chip.style.color = dn.color;
        dimsBox.appendChild(chip);
      }
    }

    renderStampBtn(id);
    $('rNeighbors').style.display = '';
    renderNeighbors(id);
    reader.classList.add('reader-open');
  }

  function closeReader() {
    reader.classList.remove('reader-open');
    S.currentReader = -1;
  }
  $('readerClose').addEventListener('click', closeReader);

  async function renderNeighbors(id) {
    const list = $('nbList');
    list.textContent = '';
    if (!S.neighbors) return;
    const ids = [];
    for (let k = 0; k < 6; k++) {
      const n = S.neighbors[id * 6 + k];
      if (n !== undefined && n !== 0xFFFF && n !== id) ids.push(n);
    }
    await Promise.all([...new Set(ids.map(shardOf))].map(loadShard));
    if (S.currentReader !== id) return;
    for (const n of ids) {
      const info = S.texts.get(n);
      if (!info) continue;
      const btn = document.createElement('button');
      btn.className = 'nb-link';
      btn.innerHTML = esc(info.t) + `<span class="nb-a">${esc(info.a)}</span>`;
      btn.addEventListener('click', () => { flyToStar(n); openStar(n); });
      list.appendChild(btn);
    }
  }

  // ---------- 星印 ----------
  function renderStampBtn(id) {
    const on = S.stamps.has(id);
    const btn = $('actStamp');
    btn.textContent = on ? '摘星印' : '蓋星印';
    btn.classList.toggle('btn-on', on);
  }
  $('actStamp').addEventListener('click', () => {
    const id = S.currentReader;
    if (id < 0) return;
    if (S.stamps.has(id)) { S.stamps.delete(id); toast('已摘除星印'); }
    else { S.stamps.add(id); toast('已蓋下星印'); }
    localStorage.setItem('tangsky.stamps', JSON.stringify([...S.stamps]));
    $('stampCount').textContent = S.stamps.size;
    renderStampBtn(id);
    applyFilters();
  });
  $('modeStamps').addEventListener('click', () => {
    if (!S.stamps.size) { toast('還沒有星印 · 打開一首詩蓋下第一枚'); return; }
    // 飞到星印质心并聚焦显示
    let sx = 0, sy = 0;
    for (const id of S.stamps) { sx += S.positions[id * 2]; sy += S.positions[id * 2 + 1]; }
    flyTo(sx / S.stamps.size, sy / S.stamps.size, Math.max(S.initScale * 2.2, 0.35));
    focusStamps();
    toast(`星印 ${S.stamps.size} 枚 · 再次點擊退出聚焦`);
  });
  let focusMode = false;
  function focusStamps() {
    focusMode = true;
    applyFilters();
  }

  // ---------- 可见度过滤 ----------
  function applyFilters() {
    if (!vertexData) return;
    const dimsOn = [...S.meta.dimNames.keys()].filter(() => false); // placeholder
    const active = activeDims();
    const N = S.starCount;
    const stampsArr = S.stamps;
    for (let i = 0; i < N; i++) {
      let vis = 1;
      if (active.length) {
        const t1 = new DataView(starBinCache).getUint8(i * 16 + 12);
        const t2 = new DataView(starBinCache).getUint8(i * 16 + 13);
        vis = (active.has(t1) || active.has(t2)) ? 1 : 0.12;
      }
      if (focusMode) vis = stampsArr.has(i) ? 1 : 0.08;
      vertexData[i * 8 + 7] = vis;
    }
    renderer.updateVisibility(vertexData);
    const shown = countVisible(active);
    $('stats').textContent = `顯示 ${shown.toLocaleString()} / ${S.starCount.toLocaleString()} 首`;
  }

  function countVisible(active) {
    if (!active || !active.size) return S.starCount;
    if (focusMode) return S.stamps.size;
    const dv = new DataView(starBinCache);
    let n = 0;
    for (let i = 0; i < S.starCount; i++) {
      if (active.has(dv.getUint8(i * 16 + 12)) || active.has(dv.getUint8(i * 16 + 13))) n++;
    }
    return n;
  }

  const activeSet = new Set();
  function activeDims() { return activeSet; }

  // ---------- 意象 chips ----------
  function buildChips() {
    const box = $('dimChips');
    box.textContent = '';
    S.meta.dimNames.forEach((d, i) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = d.name;
      chip.title = d.tip;
      chip.addEventListener('click', () => {
        if (activeSet.has(i)) activeSet.delete(i); else activeSet.add(i);
        chip.classList.toggle('chip-on', activeSet.has(i));
        applyFilters();
      });
      box.appendChild(chip);
    });
  }

  // ---------- 图例 ----------
  function buildLegend() {
    const box = $('legend');
    const pick = [0, 1, 3, 5, 8, 9, 14, 15, 19, 21, 25, 29, 32, 35]; // 取代表性的意象
    for (const i of pick) {
      const d = S.meta.dimNames[i];
      const it = document.createElement('span');
      it.className = 'lg-item';
      it.innerHTML = `<span class="lg-dot" style="background:${d.color}"></span>${esc(d.name)}`;
      box.appendChild(it);
    }
  }

  // ---------- 检索 ----------
  const searchBox = $('search');
  const resultsBox = $('searchResults');
  let searchTimer = null;

  searchBox.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 120);
  });
  searchBox.addEventListener('keydown', e => {
    if (e.key === 'Escape') { searchBox.value = ''; resultsBox.textContent = ''; searchBox.blur(); }
  });
  document.addEventListener('pointerdown', e => {
    if (!resultsBox.contains(e.target) && e.target !== searchBox) resultsBox.textContent = '';
  });

  function runSearch() {
    const q = searchBox.value.trim();
    resultsBox.textContent = '';
    if (!q || !S.index) return;
    const scored = [];
    for (const row of S.index) {
      if (!row) continue;
      let s = 0;
      if (row.t === q) s = 100;
      else if (row.t.includes(q)) s = 60;
      if (row.a === q) s = Math.max(s, 90);
      else if (row.a.includes(q)) s = Math.max(s, 50);
      if (row.head.includes(q)) s = Math.max(s, 30);
      if (s) scored.push([s, row]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const top = scored.slice(0, 24);
    if (!top.length) {
      const empty = document.createElement('div');
      empty.className = 'sr-empty';
      empty.textContent = '星空之下沒有找到。試試別的字眼。';
      resultsBox.appendChild(empty);
      return;
    }
    for (const [, row] of top) {
      const btn = document.createElement('button');
      btn.className = 'sr-item';
      btn.setAttribute('role', 'option');
      btn.innerHTML = `<span class="sr-title">${esc(row.t)}</span><span class="sr-author">${esc(row.a)}</span>` +
        `<span class="sr-snip">${esc(row.head)}</span>`;
      btn.addEventListener('click', () => {
        flyToStar(row.id);
        openStar(row.id);
        resultsBox.textContent = '';
      });
      resultsBox.appendChild(btn);
    }
  }

  // ---------- 连星成座 ----------
  const constPanel = $('constPanel');

  function setConstMode(on) {
    S.constMode = on;
    $('modeConst').classList.toggle('mode-on', on);
    constPanel.classList.toggle('hidden', !on);
    if (on) closeReader();
    renderConstList();
    if (!on) S.constStars = [];
    drawLines();
  }
  $('modeConst').addEventListener('click', () => setConstMode(!S.constMode));

  function addConstStar(id) {
    if (S.constStars.includes(id)) { toast('這顆星已在座中'); return; }
    if (S.constStars.length >= 7) { toast('星座至多七顆星'); return; }
    S.constStars.push(id);
    renderConstList();
    drawLines();
    const info = S.texts.get(id) || (S.index ? S.index[id] : null);
    toast('已連入《' + (info ? info.t : '…') + '》');
  }

  function renderConstList() {
    const list = $('constList');
    list.textContent = '';
    S.constStars.forEach((id, i) => {
      const info = S.texts.get(id) || (S.index ? S.index[id] : null);
      const row = document.createElement('div');
      row.className = 'const-item';
      row.innerHTML = `<span>${i + 1}. ${esc(info ? info.t : '…')}</span>`;
      const x = document.createElement('button');
      x.className = 'ci-x';
      x.textContent = '×';
      x.setAttribute('aria-label', '移除');
      x.addEventListener('click', () => {
        S.constStars.splice(i, 1);
        renderConstList();
        drawLines();
      });
      row.appendChild(x);
      list.appendChild(row);
    });
  }
  $('constClear').addEventListener('click', () => { S.constStars = []; renderConstList(); drawLines(); });

  $('constShare').addEventListener('click', () => {
    if (S.constStars.length < 2) { toast('至少連兩顆星'); return; }
    const name = $('constName').value.trim() || '無名星座';
    const url = location.origin + location.pathname +
      '?s=' + S.constStars.join(',') + '&n=' + encodeURIComponent(name);
    showShare(url);
  });

  // reader 里的"入星座"
  $('actLink').addEventListener('click', () => {
    const id = S.currentReader;
    if (id < 0) return;
    if (!S.constMode) setConstMode(true);
    addConstStar(id);
  });

  // ---------- 分享 ----------
  const shareBox = $('shareBox');
  function showShare(url) {
    $('shareUrl').value = url;
    shareBox.classList.remove('hidden');
    $('shareUrl').select();
  }
  $('actShare').addEventListener('click', () => {
    const id = S.currentReader;
    if (id < 0) return;
    showShare(location.origin + location.pathname + '?p=' + id);
  });
  $('shareCopy').addEventListener('click', async () => {
    const v = $('shareUrl').value;
    try {
      await navigator.clipboard.writeText(v);
      toast('已複製');
    } catch (_) {
      const inp = $('shareUrl');
      inp.select();
      try { document.execCommand('copy'); toast('已複製'); } catch (_) { toast('複製失敗 · 手動選取'); }
    }
  });
  $('shareClose').addEventListener('click', () => shareBox.classList.add('hidden'));
  shareBox.addEventListener('click', e => { if (e.target === shareBox) shareBox.classList.add('hidden'); });

  // ---------- 今夜主星 ----------
  function computeTodayStar() {
    if (!S.famousOf) return -1;
    const d = new Date();
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const h = hashStr(key);
    const famous = [];
    for (let i = 0; i < S.starCount; i++) if (S.famousOf[i]) famous.push(i);
    if (!famous.length) return -1;
    return famous[h % famous.length];
  }
  $('todayStar').addEventListener('click', () => {
    if (S.todayStarId < 0) return;
    flyToStar(S.todayStarId);
    openStar(S.todayStarId);
  });

  // ---------- URL 参数还原 ----------
  async function applyUrlParams() {
    const usp = new URLSearchParams(location.search);
    if (usp.has('s')) {
      const ids = usp.get('s').split(',').map(Number).filter(v => Number.isInteger(v) && v >= 0 && v < S.starCount);
      const name = usp.get('n') || '';
      setConstMode(true);
      $('constName').value = name;
      await Promise.all([...new Set(ids.map(shardOf))].map(loadShard));
      S.constStars = [...new Set(ids)].slice(0, 7);
      renderConstList();
      if (S.constStars.length) {
        let sx = 0, sy = 0;
        for (const id of S.constStars) { sx += S.positions[id * 2]; sy += S.positions[id * 2 + 1]; }
        flyTo(sx / S.constStars.length, sy / S.constStars.length, Math.max(S.initScale * 2.6, 0.42));
        toast('已載入星座「' + (name || '無名') + '」');
      }
    } else if (usp.has('p')) {
      const id = Number(usp.get('p'));
      if (Number.isInteger(id) && id >= 0 && id < S.starCount) {
        flyToStar(id);
        openStar(id);
      }
    }
  }

  // ---------- 复位 ----------
  $('btnResetView').addEventListener('click', () => {
    focusMode = false;
    applyFilters();
    flyTo(0, 0, S.initScale);
  });

  // ---------- 面板折叠（小屏） ----------
  $('panelToggle').addEventListener('click', () => {
    $('panel').classList.toggle('panel-collapsed');
    $('panelToggle').textContent = $('panel').classList.contains('panel-collapsed') ? '▸' : '▾';
  });

  // ---------- 启动 ----------
  let starBinCache = null;

  async function boot() {
    try {
      const [meta, starsBin] = await Promise.all([fetchJSON('data/meta.json'), fetchBuf('data/stars.bin')]);
      S.meta = meta;
      starBinCache = starsBin;
      const dv = new DataView(starsBin);
      S.starCount = dv.byteLength / 16;
      S.positions = new Float32Array(S.starCount * 2);
      S.clusterOf = new Uint16Array(S.starCount);
      S.famousOf = new Uint8Array(S.starCount);
      for (let i = 0; i < S.starCount; i++) {
        S.positions[i * 2] = dv.getFloat32(i * 16, true);
        S.positions[i * 2 + 1] = dv.getFloat32(i * 16 + 4, true);
        S.clusterOf[i] = dv.getUint16(i * 16 + 8, true);
        S.famousOf[i] = dv.getUint8(i * 16 + 14);
      }
      S.gridCell = (meta.world && meta.world.cell) || 300;
      buildGrid();

      renderer = new SkyRenderer(canvas);
      const dpr = clamp(devicePixelRatio || 1, 1, 2);
      resizeAll(dpr);
      const built = buildStarVertexData(starsBin, meta, dpr);
      vertexData = built.vertexData;
      renderer.setStars(vertexData, built.count);
      S.initScale = Math.min(innerWidth / 5200, innerHeight / 3400);
      S.cam = { x: 0, y: 0, scale: S.initScale };

      requestAnimationFrame(frame);

      // 后台加载：邻星表、检索索引、诗文首片、名篇星印
      fetchBuf('data/neighbors.bin').then(b => { S.neighbors = new Uint16Array(b); }).catch(() => {});
      loadIndex().catch(() => {});
      loadShard(0).catch(() => {});
      S.todayStarId = computeTodayStar();
      if (S.todayStarId >= 0) {
        loadShard(shardOf(S.todayStarId)).then(() => {
          const info = S.texts.get(S.todayStarId);
          if (info) $('todayStar').textContent = '今夜 · ' + info.t;
        }).catch(() => {});
      }
      $('stampCount').textContent = S.stamps.size;

      buildChips();
      buildLegend();
      buildLabels();
      $('stats').textContent = `${S.starCount.toLocaleString()} 首唐詩 · ${meta.authors.length.toLocaleString()} 位詩人`;

      // 入夜
      $('introBtn').addEventListener('click', () => {
        const intro = $('intro');
        intro.classList.add('intro-hide');
        setTimeout(() => intro.remove(), 1300);
        applyUrlParams();
      }, { once: true });
    } catch (err) {
      console.error(err);
      toast('星表載入失敗 · 請重新整理');
      const btn = $('introBtn');
      if (btn) { btn.textContent = '載入失敗'; btn.disabled = true; }
    }
  }

  function resizeAll(dpr) {
    const d = dpr || clamp(devicePixelRatio || 1, 1, 2);
    if (renderer) renderer.resize(innerWidth, innerHeight, d);
    resizeLines();
  }
  addEventListener('resize', () => resizeAll());

  boot();

  // 调试/自动化句柄（不影响正常使用）
  window.__tangsky = { S, openStar, flyToStar, applyFilters };
})();
