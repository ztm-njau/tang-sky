// 星空渲染器 —— WebGL2，程序化星点，无贴图。
// 三个绘制阶段：星云辉光（全屏 quad + fbm）→ 尘埃远星 → 主星场。
'use strict';

const STAR_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec3 aColor;
layout(location=2) in float aSize;
layout(location=3) in float aSeed;
layout(location=4) in float aVis;   // 0..1 过滤可见度
uniform vec2 uCenter;               // 相机中心（世界坐标）
uniform float uScale;               // 像素 / 世界单位
uniform vec2 uViewport;             // CSS 像素
uniform float uDpr;
uniform float uTime;
uniform float uMotion;              // 0=减少动态
out vec3 vColor;
out float vGlow;
void main() {
  vec2 screen = (aPos - uCenter) * uScale;
  // 轻微视差：远处尘埃层由 aSize<0.4 标记，随缩放位移更少
  float depth = aSize < 0.4 ? 0.55 : 1.0;
  screen *= depth;
  vec2 px = (uViewport * 0.5 + screen) * uDpr;
  vec2 clip = px / (uViewport * uDpr) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  float mag = clamp((aSize - 0.8) / 2.4, 0.0, 1.0);
  float base = 1.1 + mag * 2.7 + step(2.5, aSize) * 1.1;
  float tw = 1.0 + uMotion * 0.38 * sin(uTime * (0.6 + fract(aSeed) * 1.7) + aSeed * 17.0);
  gl_PointSize = max(base * uDpr * tw * (0.75 + 0.25 * depth), 1.0);
  vColor = aColor;
  vGlow = aVis * (0.5 + 0.5 * mag) * tw;
}`;

const STAR_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vGlow;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r = dot(d, d);
  if (r > 1.0) discard;
  float core = exp(-r * 7.0);
  float halo = exp(-r * 2.2) * 0.35;
  float a = (core + halo) * vGlow;
  outColor = vec4(vColor * a, a);
}`;

const NEBULA_VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vNdc;
void main() { vNdc = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const NEBULA_FS = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform vec2 uViewport;
uniform float uDpr;
uniform vec2 uCenter;
uniform float uScale;
uniform float uTime;
out vec4 outColor;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.55; }
  return v;
}

void main() {
  vec2 px = (vNdc * 0.5 + 0.5) * uViewport;
  vec2 world = uCenter + (vec2(px.x, uViewport.y - px.y) - uViewport * 0.5) / uScale;
  // 银河带：沿 x 轴的暗辉
  float band = exp(-pow(world.y / 620.0, 2.0));
  float n = fbm(world * 0.0016 + vec2(uTime * 0.004, 0.0));
  float wisp = fbm(world * vec2(0.0009, 0.0035) + 7.0);
  vec3 deep = vec3(0.012, 0.016, 0.033);
  vec3 tint = vec3(0.10, 0.12, 0.20);
  vec3 col = deep;
  col += tint * band * (0.35 + 0.65 * n) * 0.9;
  col += vec3(0.05, 0.055, 0.085) * wisp * 0.5;
  // 上下渐暗的暗角
  float vig = smoothstep(1.45, 0.4, length(vNdc * vec2(0.85, 1.0)));
  col *= mix(0.72, 1.0, vig);
  outColor = vec4(col, 1.0);
}`;

// 线性 -> sRGB 近似（加色混合下够用）
function srgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = v => Math.pow(v / 255, 0.85);
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

class SkyRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;

    this.starProg = this._program(STAR_VS, STAR_FS);
    this.nebProg = this._program(NEBULA_VS, NEBULA_FS);
    this.uS = this._uniforms(this.starProg, ['uCenter', 'uScale', 'uViewport', 'uDpr', 'uTime', 'uMotion']);
    this.uN = this._uniforms(this.nebProg, ['uViewport', 'uDpr', 'uCenter', 'uScale', 'uTime']);

    // 全屏 quad
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // 主星缓冲
    this.starBuf = gl.createBuffer();
    this.starVao = gl.createVertexArray();
    this.starCount = 0;
    this.capacity = 0;

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // 加色
  }

  _program(vs, fs) {
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  _uniforms(prog, names) {
    const o = {};
    for (const n of names) o[n] = this.gl.getUniformLocation(prog, n);
    return o;
  }

  // data: 打包后的顶点数据 Float32Array [x,y,r,g,b,size,seed,vis] * N
  setStars(data, count) {
    const gl = this.gl;
    gl.bindVertexArray(this.starVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const S = 8 * 4;
    const set = (loc, size, off) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, S, off);
    };
    set(0, 2, 0); set(1, 3, 8); set(2, 1, 20); set(3, 1, 24); set(4, 1, 28);
    this.starCount = count;
  }

  updateVisibility(f32) { // 只更新 vis 字段时调用（整个 buffer 重建亦可，这里直接重传）
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, f32);
  }

  resize(w, h, dpr) {
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.w = w; this.h = h; this.dpr = dpr;
  }

  render(cam, time, motion) {
    const gl = this.gl;
    // 阶段一：星云（不混合，直接覆盖）
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.useProgram(this.nebProg);
    gl.bindVertexArray(this.quadVao);
    gl.uniform2f(this.uN.uViewport, this.w, this.h);
    gl.uniform1f(this.uN.uDpr, this.dpr);
    gl.uniform2f(this.uN.uCenter, cam.x, cam.y);
    gl.uniform1f(this.uN.uScale, cam.scale);
    gl.uniform1f(this.uN.uTime, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 阶段二：星点（加色）
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.starProg);
    gl.bindVertexArray(this.starVao);
    gl.uniform2f(this.uS.uCenter, cam.x, cam.y);
    gl.uniform1f(this.uS.uScale, cam.scale);
    gl.uniform2f(this.uS.uViewport, this.w, this.h);
    gl.uniform1f(this.uS.uDpr, this.dpr);
    gl.uniform1f(this.uS.uTime, time);
    gl.uniform1f(this.uS.uMotion, motion);
    gl.drawArrays(gl.POINTS, 0, this.starCount);
  }
}

// 将 stars.bin + meta 转成渲染顶点数据；同时生成银河带尘埃远星。
// dimsColors: 意象色表；返回 { vertexData, count, dustData, dustCount, positions }
function buildStarVertexData(starsBin, meta, dprSeed) {
  const dv = starsBin instanceof DataView ? starsBin : new DataView(starsBin);
  const N = dv.byteLength / 16;
  const STRIDE = 8;
  const data = new Float32Array((N + 9000) * STRIDE);
  const positions = new Float32Array(N * 2);
  const dimColor = meta.dimNames.map(d => srgb(d.color));

  for (let i = 0; i < N; i++) {
    const x = dv.getFloat32(i * 16, true);
    const y = dv.getFloat32(i * 16 + 4, true);
    const mag = dv.getUint16(i * 16 + 10, true) / 1000;
    const t1 = dv.getUint8(i * 16 + 12);
    const t2 = dv.getUint8(i * 16 + 13);
    const famous = dv.getUint8(i * 16 + 14);
    const c1 = dimColor[t1] || [0.8, 0.8, 0.9];
    const c2 = dimColor[t2] || c1;
    // 主意象色 45% + 次意象 15% + 星光白 40%，压向冷白
    const r = Math.min(1, c1[0] * 0.45 + c2[0] * 0.15 + 0.40);
    const g = Math.min(1, c1[1] * 0.45 + c2[1] * 0.15 + 0.42);
    const b = Math.min(1, c1[2] * 0.45 + c2[2] * 0.15 + 0.46);
    const size = 0.9 + mag * 2.4 + (famous ? 1.6 : 0);
    const seed = ((Math.sin(i * 127.1) * 43758.5453) % 1 + 1) % 1 * 100;
    const o = i * STRIDE;
    data[o] = x; data[o + 1] = y; data[o + 2] = r; data[o + 3] = g; data[o + 4] = b;
    data[o + 5] = size; data[o + 6] = seed; data[o + 7] = 1;
    positions[i * 2] = x; positions[i * 2 + 1] = y;
  }
  // 尘埃远星：小、暗、聚在银河带附近，制造纵深
  let di = N * STRIDE;
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let k = 0; k < 9000; k++) {
    const x = (rnd() * 2 - 1) * 2300;
    const y = (rnd() + rnd() + rnd() - 1.5) * 480; // 中间密
    const o = di; di += STRIDE;
    data[o] = x; data[o + 1] = y;
    data[o + 2] = 0.55; data[o + 3] = 0.58; data[o + 4] = 0.70;
    data[o + 5] = 0.25 + rnd() * 0.13; // <0.4 → 尘埃层
    data[o + 6] = rnd() * 100;
    data[o + 7] = 0.5;
  }
  return {
    vertexData: data,
    count: N + 9000,
    dustCount: 9000,
    positions,
    starCount: N,
  };
}
