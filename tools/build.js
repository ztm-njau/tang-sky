#!/usr/bin/env node
// 唐诗星图 数据管线
// 读入《全唐诗》→ 意象向量化 → cosine 相似 landmark-MDS 二维投影 →
// k-means 星团 → 邻星表 → 打包为前端可用的分片数据。
'use strict';
const fs = require('fs');
const path = require('path');
const imagery = require('./imagery');
const CLN = require('./constellation-names');
const BEST = require('./best');
const OpenCC = require('opencc-js');
const toCN = OpenCC.Converter({ from: 't', to: 'cn' });

const RAW = path.join(__dirname, '..', 'raw');
const PUB = path.join(__dirname, '..', 'public', 'data');

// ---------- 1. 载入与解析 ----------
function loadPoems() {
  const files = fs.readdirSync(RAW).filter(f => /^poet\.tang\.\d+\.json$/.test(f));
  const poems = [];
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
    for (const p of arr) {
      if (!p.paragraphs || !p.paragraphs.length) continue;
      const text = toCN(p.paragraphs.join('\n'));
      if (text.length < 12) continue; // 过短残句不成星
      poems.push({ a: toCN(p.author || '佚名'), t: toCN((p.title || '无题').trim()), c: text });
    }
  }
  return poems;
}

// ---------- 2. 意象向量化 ----------
// 每个维度 = (标题命中×title权重 + 正文命中) × IDF，再压缩、L2 归一化。
// IDF 压制"千/百/无/空"这类泛字，让特色意象（雪/雁/剑/桑）得以出头。
const DIMS = imagery.length;
// 可复现的伪随机（mulberry32）
const SEED = 20261104;
function rng() {
  let t = SEED >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function vectorize(poems) {
  const N = poems.length;
  // 第一遍：原始得分 + 文档频率
  const raw = new Float32Array(N * DIMS);
  const df = new Uint32Array(DIMS);
  for (let i = 0; i < N; i++) {
    const p = poems[i];
    const v = raw.subarray(i * DIMS, (i + 1) * DIMS);
    for (let d = 0; d < DIMS; d++) {
      const im = imagery[d];
      let score = 0;
      const hits = Array.isArray(im.hit) ? im.hit : [im.hit];
      const inTitle = im.id !== 'night' && hits.some(h => p.t.includes(h)); // "夜"例外：标题带夜字未必点夜
      for (const h of hits) {
        let idx = 0, n = 0;
        while ((idx = p.c.indexOf(h, idx)) !== -1) { n++; idx += h.length; if (n > 40) break; }
        if (n) score += 1 + Math.log2(n);
      }
      if (inTitle) score += im.title || 1.5;
      if (score > 0) { v[d] = score; df[d]++; }
    }
  }
  const idf = new Float32Array(DIMS);
  for (let d = 0; d < DIMS; d++) idf[d] = df[d] ? Math.min(4, Math.max(0.08, Math.log(N / df[d]))) : 1;

  // 第二遍：IDF 加权 + 中心化 + 压缩 + 归一化
  // 中心化：减去语料均值后，"人人都有"的维度不再参与相似度计算，
  // 相似性完全由特色意象的重合决定。
  const mean = new Float32Array(DIMS);
  for (let i = 0; i < N; i++) for (let d = 0; d < DIMS; d++) mean[d] += raw[i * DIMS + d];
  for (let d = 0; d < DIMS; d++) mean[d] /= N;
  const top = new Uint8Array(N * 2);
  for (let i = 0; i < N; i++) {
    const v = raw.subarray(i * DIMS, (i + 1) * DIMS);
    // 带符号平方根：保留"低于平均"的负值。截零会让多数向量互相正交，
    // 余弦几何塌成 hub；带符号则相似度由"意象轮廓"决定。
    for (let d = 0; d < DIMS; d++) {
      const x = v[d] ? (v[d] - mean[d]) * idf[d] : 0;
      v[d] = x ? Math.sign(x) * Math.min(1.6, Math.sqrt(Math.abs(x) / 5)) : 0;
    }
    let s = 0; for (let d = 0; d < DIMS; d++) s += v[d] * v[d];
    if (s < 1e-9) { for (let d = 0; d < DIMS; d++) v[d] = 0.12; s = DIMS * 0.0144; }
    s = Math.sqrt(s);
    for (let d = 0; d < DIMS; d++) v[d] /= s;
    let i1 = 0, i2 = 0;
    for (let d = 1; d < DIMS; d++) { if (v[d] > v[i1]) { i2 = i1; i1 = d; } else if (v[d] > v[i2]) i2 = d; }
    top[i * 2] = i1; top[i * 2 + 1] = i2;
  }
  return { vecs: raw, top, idf, df };
}

// ---------- 3. landmark-MDS 降维 ----------
// 全量 4.4 万两两相似度是 ~10^9 次运算，改用 landmark-MDS：
// 取 ~1400 个地标，全量点对地标求相似度，SVD 分解地标距离矩阵，
// 再把其余点用三角关系投影出去。O(N·L) 而非 O(N²)。
function dimReduce(poems, vecs) {
  const N = poems.length, L = 1400;
  const stride = Math.max(1, Math.floor(N / L));
  const lm = []; // 地标下标
  for (let i = 0; i < N && lm.length < L; i += stride) lm.push(i);
  const lmn = lm.length;

  // 地标两两 cosine 距离
  const DL = new Float64Array(lmn * lmn);
  for (let a = 0; a < lmn; a++) {
    for (let b = a + 1; b < lmn; b++) {
      let dot = 0;
      const va = vecs.subarray(lm[a] * DIMS, (lm[a] + 1) * DIMS);
      const vb = vecs.subarray(lm[b] * DIMS, (lm[b] + 1) * DIMS);
      for (let d = 0; d < DIMS; d++) dot += va[d] * vb[d];
      const dist = 1 - dot; // cosine distance ∈ [0,2]
      DL[a * lmn + b] = DL[b * lmn + a] = dist;
    }
  }
  // 双中心化 B = -0.5 J D² J
  const B = new Float64Array(lmn * lmn);
  const rowM = new Float64Array(lmn), colM = new Float64Array(lmn);
  let tot = 0;
  for (let a = 0; a < lmn; a++) for (let b = 0; b < lmn; b++) {
    const d2 = DL[a * lmn + b] ** 2;
    rowM[a] += d2; colM[b] += d2; tot += d2;
    B[a * lmn + b] = -0.5 * d2;
  }
  for (let a = 0; a < lmn; a++) for (let b = 0; b < lmn; b++)
    B[a * lmn + b] += rowM[a] / lmn + colM[b] / lmn - tot / (lmn * lmn);

  // 幂迭代 + 热门差值法求前两特征向量
  function powerIter(M, n) {
    const rand = rng();
    let v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = rand() - 0.5;
    let lam = 0;
    for (let it = 0; it < 60; it++) {
      const w = new Float64Array(n);
      for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += M[i * n + j] * v[j]; w[i] = s; }
      const nw = Math.hypot(...w) || 1;
      for (let i = 0; i < n; i++) w[i] /= nw;
      lam = nw; v = w;
    }
    return { v, lam };
  }
  function deflate(M, v, lam, n) { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) M[i * n + j] -= lam * v[i] * v[j]; }

  const M1 = Float64Array.from(B);
  const p1 = powerIter(M1, lmn); deflate(B, p1.v, p1.lam, lmn);
  const M2 = Float64Array.from(B);
  const p2 = powerIter(M2, lmn);
  const V = [p1.v, p2.v]; // 前两特征向量
  // MDS 地标坐标 = √λ · v
  const XL = [new Float64Array(lmn), new Float64Array(lmn)];
  for (let k = 0; k < lmn; k++) {
    XL[0][k] = Math.sqrt(Math.max(p1.lam, 0)) * V[0][k];
    XL[1][k] = Math.sqrt(Math.max(p2.lam, 0)) * V[1][k];
  }

  // 全量点投影（Gower 插值）：x_i,dim = -0.5 Σ_k (d²_ik − mean_i) v_dim[k] / √λ_dim
  // 地标自身用 √λ·v，与域外点同一尺度。
  const pts = new Float32Array(N * 2);
  const lmIndex = new Map(lm.map((p, k) => [p, k]));
  const dToLm = new Float64Array(lmn);
  const sq1 = Math.sqrt(Math.max(p1.lam, 1e-9)), sq2 = Math.sqrt(Math.max(p2.lam, 1e-9));
  for (let i = 0; i < N; i++) {
    const lk = lmIndex.get(i);
    if (lk !== undefined) { pts[i * 2] = XL[0][lk]; pts[i * 2 + 1] = XL[1][lk]; continue; }
    const vi = vecs.subarray(i * DIMS, (i + 1) * DIMS);
    let mean = 0;
    for (let k = 0; k < lmn; k++) {
      const vl = vecs.subarray(lm[k] * DIMS, (lm[k] + 1) * DIMS);
      let dot = 0; for (let d = 0; d < DIMS; d++) dot += vi[d] * vl[d];
      dToLm[k] = (1 - dot) ** 2; mean += dToLm[k];
    }
    mean /= lmn;
    let s0 = 0, s1 = 0;
    const v0 = V[0], v1 = V[1];
    for (let k = 0; k < lmn; k++) {
      const dk = dToLm[k] - mean;
      s0 += dk * v0[k]; s1 += dk * v1[k];
    }
    pts[i * 2] = -0.5 * s0 / sq1;
    pts[i * 2 + 1] = -0.5 * s1 / sq2;
    if (!isFinite(pts[i * 2]) || !isFinite(pts[i * 2 + 1])) { pts[i * 2] = rng()() - 0.5; pts[i * 2 + 1] = rng()() - 0.5; }
  }
  return pts;
}

// ---------- 4. 归一化到画布域 & 星等 ----------
function normalize(pts, poems, vecs) {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let i = 0; i < poems.length; i++) {
    minX = Math.min(minX, pts[i * 2]); maxX = Math.max(maxX, pts[i * 2]);
    minY = Math.min(minY, pts[i * 2 + 1]); maxY = Math.max(maxY, pts[i * 2 + 1]);
  }
  // 主轴旋转：把分布的主方差方向转到水平，密度脊呈现为一条"银河"
  let mx = 0, my = 0;
  for (let i = 0; i < poems.length; i++) { mx += pts[i * 2]; my += pts[i * 2 + 1]; }
  mx /= poems.length; my /= poems.length;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let i = 0; i < poems.length; i++) {
    const dx = pts[i * 2] - mx, dy = pts[i * 2 + 1] - my;
    cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const cosT = Math.cos(theta), sinT = Math.sin(theta);
  const rot = new Float64Array(poems.length * 2);
  for (let i = 0; i < poems.length; i++) {
    const dx = pts[i * 2] - mx, dy = pts[i * 2 + 1] - my;
    rot[i * 2] = dx * cosT + dy * sinT;
    rot[i * 2 + 1] = -dx * sinT + dy * cosT;
  }
  // 稳健缩放：MDS 次轴散布远小于主轴，直接等比会压成一条线。
  // 分别按分位数把主轴拉到 ~3600、次轴撑到 ~1500 世界单位，成有厚度的银河带。
  const pct = (arr, p) => { const s = Float64Array.from(arr).sort(); return s[Math.floor(s.length * p)]; };
  const rxAll = new Float64Array(poems.length), ryAll = new Float64Array(poems.length);
  for (let i = 0; i < poems.length; i++) { rxAll[i] = rot[i * 2]; ryAll[i] = rot[i * 2 + 1]; }
  const xLo = pct(rxAll, 0.005), xHi = pct(rxAll, 0.995);
  const yLo = pct(ryAll, 0.02), yHi = pct(ryAll, 0.98);
  const xMid = (xLo + xHi) / 2, yMid = (yLo + yHi) / 2;
  const XS = 3600 / (xHi - xLo || 1), YS = 1500 / (yHi - yLo || 1);
  const out = new Float32Array(poems.length * 2);
  for (let i = 0; i < poems.length; i++) {
    out[i * 2] = (rot[i * 2] - xMid) * XS;
    out[i * 2 + 1] = (rot[i * 2 + 1] - yMid) * YS;
  }
  // 星等：意象浓度（L2 范数高 = 意象密集）+ 文本长度
  const mag = new Float32Array(poems.length);
  for (let i = 0; i < poems.length; i++) {
    const v = vecs.subarray(i * DIMS, (i + 1) * DIMS);
    let s = 0; for (let d = 0; d < DIMS; d++) s += v[d] * v[d];
    mag[i] = Math.sqrt(s) * Math.sqrt(Math.min(poems[i].c.length, 400) / 400);
  }
  // 拉开分布
  const sorted = Float32Array.from(mag).sort();
  const q = p => sorted[Math.floor(sorted.length * p)];
  const lo = q(0.02), hi = q(0.98);
  for (let i = 0; i < mag.length; i++) mag[i] = Math.max(0.04, Math.min(1, (mag[i] - lo) / (hi - lo || 1)));
  return { pos: out, mag };
}

// ---------- 5. k-means 星团 ----------
function kmeans(pos, N, K = 36, iters = 24) {
  const rand = rng();
  // k-means++ 初始化
  const cent = new Float64Array(K * 2);
  const seed = Math.floor(rand() * N);
  cent[0] = pos[seed * 2]; cent[1] = pos[seed * 2 + 1];
  const d2 = new Float64Array(N).fill(Infinity);
  for (let k = 1; k < K; k++) {
    const last = cent.subarray((k - 1) * 2, k * 2);
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const dx = pos[i * 2] - last[0], dy = pos[i * 2 + 1] - last[1];
      const dd = dx * dx + dy * dy;
      if (dd < d2[i]) d2[i] = dd;
      sum += d2[i];
    }
    let r = rand() * sum;
    let pick = 0;
    for (let i = 0; i < N; i++) { r -= d2[i]; if (r <= 0) { pick = i; break; } }
    cent[k * 2] = pos[pick * 2]; cent[k * 2 + 1] = pos[pick * 2 + 1];
  }
  const assign = new Uint16Array(N);
  for (let it = 0; it < iters; it++) {
    let moved = 0;
    for (let i = 0; i < N; i++) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const dx = pos[i * 2] - cent[k * 2], dy = pos[i * 2 + 1] - cent[k * 2 + 1];
        const dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; best = k; }
      }
      if (assign[i] !== best) { assign[i] = best; moved++; }
    }
    const cs = new Float64Array(K * 3);
    for (let i = 0; i < N; i++) { const k = assign[i]; cs[k * 3] += pos[i * 2]; cs[k * 3 + 1] += pos[i * 2 + 1]; cs[k * 3 + 2]++; }
    for (let k = 0; k < K; k++) if (cs[k * 3 + 2] > 0) { cent[k * 2] = cs[k * 3] / cs[k * 3 + 2]; cent[k * 2 + 1] = cs[k * 3 + 1] / cs[k * 3 + 2]; }
    if (moved / N < 0.005) break;
  }
  return { assign, cent };
}

// ---------- 6. 邻星表（kNN，网格加速） ----------
function knn(pos, N, K = 6) {
  const cell = 300;
  const grid = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const buckets = [];
  for (let i = 0; i < N; i++) {
    const k = key(pos[i * 2], pos[i * 2 + 1]);
    if (!grid.has(k)) { grid.set(k, []); buckets.push(grid.get(k)); }
    grid.get(k).push(i);
  }
  const nb = new Uint16Array(N * K);
  for (let i = 0; i < N; i++) {
    const gx = Math.floor(pos[i * 2] / cell), gy = Math.floor(pos[i * 2 + 1] / cell);
    const cand = [];
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const b = grid.get(`${gx + ox},${gy + oy}`); if (b) cand.push(...b);
    }
    const best = [];
    for (const j of cand) {
      if (j === i) continue;
      const dx = pos[i * 2] - pos[j * 2], dy = pos[i * 2 + 1] - pos[j * 2 + 1];
      const d = dx * dx + dy * dy;
      if (best.length < K) { best.push({ j, d }); best.sort((a, b) => a.d - b.d); }
      else if (d < best[K - 1].d) { best[K - 1] = { j, d }; best.sort((a, b) => a.d - b.d); }
    }
    for (let k = 0; k < K; k++) nb[i * K + k] = best[k] ? best[k].j : 0xFFFF;
  }
  return nb;
}

// ---------- main ----------
function main() {
  console.time('load');
  const poems = loadPoems();
  console.timeEnd('load');
  console.log('poems:', poems.length);

  console.time('vectorize');
  const { vecs, top } = vectorize(poems);
  console.timeEnd('vectorize');

  console.time('mds');
  const pts = dimReduce(poems, vecs);
  console.timeEnd('mds');

  console.time('norm');
  const { pos, mag } = normalize(pts, poems, vecs);
  console.timeEnd('norm');

  console.time('kmeans');
  const { assign, cent } = kmeans(pos, poems.length);
  console.timeEnd('kmeans');

  console.time('knn');
  const nb = knn(pos, poems.length);
  console.timeEnd('knn');

  // 星团画像：命名与展示都用"区分度"——星团内原始得分均值 ÷ 全语料均值。
  // 几何相似度用归一化+中心化向量，但命名若也用它，特征意象会在诗间
  // 互相抵消，泛化维度（心/思/年）反而胜出，所以这里回到原始口径。
  const clRaw = Array.from({ length: 36 }, () => new Float64Array(DIMS));
  const clCnt = new Uint32Array(36);
  for (let i = 0; i < poems.length; i++) {
    const k = assign[i]; clCnt[k]++;
    const v = vecs.subarray(i * DIMS, (i + 1) * DIMS);
    for (let d = 0; d < DIMS; d++) clRaw[k][d] += v[d];
  }
  const gRaw = new Float64Array(DIMS);
  for (let i = 0; i < poems.length; i++) for (let d = 0; d < DIMS; d++) gRaw[d] += vecs[i * DIMS + d];
  for (let d = 0; d < DIMS; d++) gRaw[d] /= poems.length;

  const dimIds = imagery.map(d => d.id);
  const rate = (k, d) => (clRaw[k][d] / (clCnt[k] || 1)) / (gRaw[d] + 1e-6);
  const pairs = [];
  for (let k = 0; k < 36; k++) {
    const topDims = Array.from({ length: DIMS }, (_, d) => [d, rate(k, d)])
      .filter(([d, v]) => v > 1.15 && clRaw[k][d] > 0) // 显著高于全语料才有资格
      .sort((a, b) => b[1] - a[1]).slice(0, 6);
    for (const [d, v] of topDims) {
      const nameIdx = CLN.findIndex(n => n.best === dimIds[d]);
      if (nameIdx >= 0) pairs.push({ k, nameIdx, score: v });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedNames = new Set(), clusterName = new Array(36).fill(-1);
  for (const p of pairs) {
    if (clusterName[p.k] >= 0 || usedNames.has(p.nameIdx)) continue;
    clusterName[p.k] = p.nameIdx; usedNames.add(p.nameIdx);
  }
  // 没认领到名字的团给中性名
  const fallbackNames = ['星汉灿烂', '河汉清且浅', '盈盈一水间', '脉脉不得语', '迢迢牵牛星', '皎皎河汉女'];
  let fb = 0;
  for (let k = 0; k < 36; k++) if (clusterName[k] < 0) clusterName[k] = -2 - (fb++ % fallbackNames.length);

  const clusters = [];
  for (let k = 0; k < 36; k++) {
    const dims = Array.from({ length: DIMS }, (_, d) => [d, rate(k, d)])
      .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([d]) => d);
    const cx = cent[k * 2], cy = cent[k * 2 + 1];
    const ni = clusterName[k];
    const name = ni >= 0 ? CLN[ni].name : fallbackNames[(-ni) - 2];
    clusters.push({
      id: k,
      name,
      tip: ni >= 0 ? CLN[ni].tip : '银河一段，无可名状',
      cx: +cx.toFixed(1), cy: +cy.toFixed(1),
      n: clCnt[k],
      dims,
      r: Math.max(180, Math.sqrt(clCnt[k]) * 32),
    });
  }

  // 名诗星：BEST 里列出的题名 → 找到对应诗
  const stars = poems.map((p, i) => ({
    id: i,
    x: +pos[i * 2].toFixed(1),
    y: +pos[i * 2 + 1].toFixed(1),
    c: assign[i],
    m: +mag[i].toFixed(3),
    t1: top[i * 2], t2: top[i * 2 + 1],
  }));
  const nameMap = new Map();
  for (const q of BEST) {
    // 找该作者名下题名最接近的
    let bi = -1, bs = 0;
    for (let i = 0; i < poems.length; i++) {
      if (q.by && poems[i].a !== q.by) continue;
      let s = 0;
      const titles = [q.t, ...(q.alt || [])];
      for (const tt of titles) {
        if (poems[i].t === tt) s = Math.max(s, 100);
        else if (poems[i].t.includes(tt) || tt.includes(poems[i].t)) s = Math.max(s, 60);
        else {
          const a = poems[i].t.slice(0, 4), b = tt.slice(0, 4);
          if (a && a === b) s = Math.max(s, 40);
        }
      }
      if (s > bs) { bs = s; bi = i; }
    }
    if (bi >= 0 && bs >= 40) {
      nameMap.set(bi, q.note || '');
      stars[bi].f = 1;
    } else console.warn('not found:', q.t, q.by);
  }

  fs.mkdirSync(PUB, { recursive: true });
  // 星表二进制：每 16 字节一颗星:
  // x(f32) y(f32) cluster(u16) mag(u16=x1000) top1(u8) top2(u8) flag(u8) pad(u8)
  const buf = Buffer.alloc(stars.length * 16);
  stars.forEach((s, i) => {
    buf.writeFloatLE(s.x, i * 16);
    buf.writeFloatLE(s.y, i * 16 + 4);
    buf.writeUInt16LE(s.c, i * 16 + 8);
    buf.writeUInt16LE(Math.round(s.m * 1000), i * 16 + 10);
    buf.writeUInt8(s.t1, i * 16 + 12);
    buf.writeUInt8(s.t2, i * 16 + 13);
    buf.writeUInt8(s.f ? 1 : 0, i * 16 + 14);
  });
  fs.writeFileSync(path.join(PUB, 'stars.bin'), buf);
  // 邻星表：每星 6 个近邻（u16），供前端"邻星"跳转
  fs.writeFileSync(path.join(PUB, 'neighbors.bin'), Buffer.from(nb.buffer, nb.byteOffset, nb.byteLength));

  // 诗文按星团分片（懒加载）
  const shardCount = 12;
  const shards = Array.from({ length: shardCount }, () => []);
  const textIdx = new Uint32Array(stars.length); // 全局 id → (shard, offset) 打包
  for (let i = 0; i < poems.length; i++) {
    const sh = i % shardCount;
    const obj = { i, a: poems[i].a, t: poems[i].t, c: poems[i].c };
    if (nameMap.has(i)) obj.n = nameMap.get(i);
    shards[sh].push(obj);
  }
  shards.forEach((arr, s) => {
    fs.writeFileSync(path.join(PUB, 'texts', `t${s}.json`), JSON.stringify(arr));
  });

  // 索引 & 元数据
  const authors = {};
  for (const p of poems) authors[p.a] = (authors[p.a] || 0) + 1;
  const meta = {
    total: poems.length,
    dims: DIMS,
    world: { min: -2000, max: 2000, cell: 300 },
    dimNames: imagery.map(d => ({ id: d.id, name: d.name, color: d.color, tip: d.tip })),
    clusters,
    authors: Object.entries(authors).map(([n, c]) => ({ n, c })).sort((a, b) => b.c - a.c),
  };
  fs.writeFileSync(path.join(PUB, 'meta.json'), JSON.stringify(meta));

  // 轻量检索索引：id\t题名\t作者\t首句前16字
  const idxLines = [];
  for (let i = 0; i < poems.length; i++) {
    const head = poems[i].c.replace(/\s+/g, '').slice(0, 16);
    idxLines.push(i + '\t' + poems[i].t + '\t' + poems[i].a + '\t' + head);
  }
  fs.writeFileSync(path.join(PUB, 'index.txt'), idxLines.join('\n'));
  console.log('clusters:', clusters.map(c => `${c.name}:${c.n}`).join(' '));
  console.log('stars.bin:', (buf.length / 1024).toFixed(0) + 'KB');
  console.log('DONE');
}

main();
