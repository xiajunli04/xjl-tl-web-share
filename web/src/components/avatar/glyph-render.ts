/**
 * 字形粒子渲染器（add-platform-mascot D4）：把 glyph-field 的输出画到画布上。
 * - WebGL：一次 drawArrays(POINTS)，点精灵从字形图集取字，几千个粒子也很轻
 * - Canvas2D：不支持 WebGL / 上下文丢失时使用，同一份输出、同样的画风（字形 + 圆点）
 * 暗色主题用叠加混合（发光），浅色主题用普通混合（墨色）。
 */
import { ATLAS_GRID, DOT, GLYPH_COUNT, LETTERS, SMALL_DOT, SPARK, STRIDE, ZED } from "@/lib/avatar/glyph-field";

export interface GlyphRenderer {
  readonly kind: "webgl" | "canvas";
  readonly canvas: HTMLCanvasElement;
  resize(width: number, height: number): void;
  draw(out: Float32Array, count: number, dark: boolean): void;
  dispose(): void;
}

const FONT = `"Noto Sans SC","PingFang SC","Microsoft YaHei","Hiragino Sans","Malgun Gothic","Apple SD Gothic Neo",ui-sans-serif,system-ui,sans-serif`;
const CELL = 64;

function newCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:pan-y";
  return c;
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r * 0.28 : r;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

let atlasCache: HTMLCanvasElement | null = null;

/** 白色字形图集（alpha 通道即字形；字形带一圈柔光，圆点为柔边圆） */
export function glyphAtlas(): HTMLCanvasElement {
  if (atlasCache) return atlasCache;
  const size = CELL * ATLAS_GRID;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let g = 0; g < GLYPH_COUNT; g++) {
    const cx = (g % ATLAS_GRID) * CELL + CELL / 2;
    const cy = Math.floor(g / ATLAS_GRID) * CELL + CELL / 2;
    if (g === DOT || g === SMALL_DOT) {
      const r = CELL * (g === DOT ? 0.3 : 0.17);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.65, "rgba(255,255,255,0.95)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.fillStyle = "#fff";
      continue;
    }
    ctx.save();
    ctx.shadowColor = "rgba(255,255,255,0.85)";
    ctx.shadowBlur = CELL * 0.1;
    if (g === SPARK) star(ctx, cx, cy, CELL * 0.4);
    else {
      ctx.font = g === ZED ? `800 ${CELL * 0.62}px ${FONT}` : `600 ${CELL * 0.6}px ${FONT}`;
      ctx.fillText(g === ZED ? "Z" : LETTERS[g], cx, cy + CELL * 0.03);
    }
    ctx.restore();
  }
  atlasCache = c;
  return c;
}

/* ---------------- WebGL ---------------- */

const VERT = `
attribute vec2 aPos;
attribute float aSize;
attribute float aGlyph;
attribute vec4 aColor;
uniform vec2 uView;
uniform float uMaxSize;
varying vec4 vColor;
varying float vGlyph;
void main() {
  vec2 ndc = aPos / uView * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  gl_PointSize = min(aSize, uMaxSize);
  vColor = aColor;
  vGlyph = aGlyph;
}`;

const FRAG = `
precision mediump float;
uniform sampler2D uAtlas;
uniform float uAlphaScale;
varying vec4 vColor;
varying float vGlyph;
void main() {
  vec2 cell = vec2(mod(vGlyph, ${ATLAS_GRID}.0), floor(vGlyph / ${ATLAS_GRID}.0));
  float a = texture2D(uAtlas, (cell + gl_PointCoord) / ${ATLAS_GRID}.0).a * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * a, a * uAlphaScale);
}`;

function shader(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

/** 失败（不支持 / 编译错误）返回 null；onLost 在上下文丢失时调用 */
export function createWebGLRenderer(onLost: () => void): GlyphRenderer | null {
  const canvas = newCanvas();
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, powerPreference: "low-power" }) as WebGLRenderingContext | null;
  if (!gl) return null;
  try {
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const bytes = STRIDE * 4;
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, bytes, offset * 4);
    };
    attr("aPos", 2, 0);
    attr("aSize", 1, 2);
    attr("aGlyph", 1, 3);
    attr("aColor", 4, 4);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, glyphAtlas());
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const uView = gl.getUniformLocation(prog, "uView");
    const uAlphaScale = gl.getUniformLocation(prog, "uAlphaScale");
    gl.uniform1i(gl.getUniformLocation(prog, "uAtlas"), 0);
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;
    gl.uniform1f(gl.getUniformLocation(prog, "uMaxSize"), range?.[1] ?? 64);
    gl.enable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);

    const lost = (e: Event) => {
      e.preventDefault();
      onLost();
    };
    canvas.addEventListener("webglcontextlost", lost);

    return {
      kind: "webgl",
      canvas,
      resize(w, h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
        gl.uniform2f(uView, w, h);
      },
      draw(out, count, dark) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!count) return;
        // 预乘 alpha：暗色叠加发光，浅色普通覆盖
        if (dark) gl.blendFunc(gl.ONE, gl.ONE);
        else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1f(uAlphaScale, dark ? 0.7 : 1);
        gl.bufferData(gl.ARRAY_BUFFER, out.subarray(0, count * STRIDE), gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.POINTS, 0, count);
      },
      dispose() {
        canvas.removeEventListener("webglcontextlost", lost);
        gl.deleteBuffer(buf);
        gl.deleteTexture(tex);
        gl.deleteProgram(prog);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        canvas.remove();
      },
    };
  } catch {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  }
}

/* ---------------- Canvas2D ---------------- */

/** 把粒子画到 2D 上下文（实时降级与小图标共用） */
export function drawGlyphs2D(ctx: CanvasRenderingContext2D, out: Float32Array, count: number, dark: boolean) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.globalCompositeOperation = dark ? "lighter" : "source-over";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let font = 0;
  for (let i = 0; i < count; i++) {
    const o = i * STRIDE;
    const x = out[o];
    const y = out[o + 1];
    const size = out[o + 2];
    const g = out[o + 3];
    ctx.globalAlpha = Math.min(1, out[o + 7] * (dark ? 0.85 : 1));
    ctx.fillStyle = `rgb(${(out[o + 4] * 255) | 0},${(out[o + 5] * 255) | 0},${(out[o + 6] * 255) | 0})`;
    if (g === DOT || g === SMALL_DOT || size < 7) {
      const r = size * (g === SMALL_DOT ? 0.17 : g === DOT ? 0.3 : 0.2);
      if (r < 1.2) ctx.fillRect(x - r, y - r, r * 2, r * 2);
      else {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (g === SPARK) star(ctx, x, y, size * 0.4);
    else {
      const px = Math.round(size * 0.6);
      if (px !== font) {
        font = px;
        ctx.font = `600 ${px}px ${FONT}`;
      }
      ctx.fillText(g === ZED ? "Z" : LETTERS[g], x, y);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

export function createCanvasRenderer(): GlyphRenderer {
  const canvas = newCanvas();
  const ctx = canvas.getContext("2d")!;
  return {
    kind: "canvas",
    canvas,
    resize(w, h) {
      canvas.width = w;
      canvas.height = h;
    },
    draw(out, count, dark) {
      drawGlyphs2D(ctx, out, count, dark);
    },
    dispose() {
      canvas.remove();
    },
  };
}
