"use client";

/**
 * 立绘绑定渲染器（rework-avatar-portrait-rig D1）：懒加载 chunk，只能经 ai-avatar.tsx 的 next/dynamic 引入。
 *
 * 单个 three.js 全屏四边形 + 片元着色器：
 *   屏幕 uv → 可见子矩形（构图）→ 呼吸 / 前倾缩放 → 深度视差 → 采样立绘（alpha = 抠像蒙版）
 *   → 叠加至多 7 个局部图层（图集，按权重混合）→ 饱和度 → 底部渐隐 → 预乘 alpha 输出
 * 逐帧权重由 lib/avatar/rig-weights.ts 计算；口型来自播放输出频谱（lib/avatar/lipsync.ts）。
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { avatarAssetUrl, type CharacterId, type LayerName, type RigManifest } from "@/lib/avatar/characters";
import { createSmoother, pseudoVisemes, visemesFromSpectrum, zeroVisemes } from "@/lib/avatar/lipsync";
import { createRigAnimator } from "@/lib/avatar/rig-weights";
import type { AvatarState } from "@/lib/avatar/state";
import { createFpsMonitor } from "@/lib/avatar/support";
import { viewRect, type Framing } from "@/lib/avatar/view";
import { loadManifest } from "./manifest";
import type { AvatarSignals } from "./types";

const MAX_LAYERS = 7;

export interface PortraitRigProps {
  character: CharacterId;
  state: AvatarState;
  signals?: AvatarSignals;
  framing: Framing;
  interactive: boolean;
  greetKey?: number;
  onReady?: () => void;
  onError?: () => void;
  onLowFps?: () => void;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uBase;
uniform sampler2D uDepth;
uniform sampler2D uAtlas;
uniform vec4 uView;
uniform vec2 uOffset;
uniform float uScale;
uniform float uSat;
uniform float uBottomFade;
uniform vec4 uDst[${MAX_LAYERS}];
uniform vec4 uSrc[${MAX_LAYERS}];
uniform float uW[${MAX_LAYERS}];
varying vec2 vUv;

void main() {
  // 屏幕 uv（y 向上）→ 立绘 uv（y 向下，与资源坐标一致）
  vec2 uv = uView.xy + vec2(vUv.x, 1.0 - vUv.y) * uView.zw;
  // 以立绘底部中心为原点缩放（呼吸 / 前倾）
  uv = vec2(0.5, 1.0) + (uv - vec2(0.5, 1.0)) / uScale;
  float depth = texture2D(uDepth, clamp(uv, 0.0, 1.0)).r;
  vec2 p = uv + uOffset * (depth - 0.35);
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec4 c = texture2D(uBase, p);
  for (int i = 0; i < ${MAX_LAYERS}; i++) {
    if (uW[i] > 0.002) {
      vec2 l = (p - uDst[i].xy) / uDst[i].zw;
      if (l.x >= 0.0 && l.y >= 0.0 && l.x <= 1.0 && l.y <= 1.0) {
        vec4 o = texture2D(uAtlas, uSrc[i].xy + l * uSrc[i].zw);
        c.rgb = mix(c.rgb, o.rgb, o.a * uW[i]);
      }
    }
  }
  float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  c.rgb = mix(vec3(g), c.rgb, uSat);
  // 立绘底边渐隐，与舞台背景融合
  c.a *= 1.0 - uBottomFade * smoothstep(0.86, 1.0, p.y);
  gl_FragColor = vec4(c.rgb * c.a, c.a);
}
`;

function loadTexture(url: string): Promise<THREE.Texture> {
  return new THREE.TextureLoader().loadAsync(url).then((t) => {
    t.flipY = false;
    t.colorSpace = THREE.NoColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    return t;
  });
}

export default function PortraitRig(props: PortraitRigProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const greet = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (props.greetKey) greet.current?.();
  }, [props.greetKey]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let raf = 0;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: "low-power" });
    } catch {
      latest.current.onError?.();
      return;
    }
    renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    const canvas = renderer.domElement;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    el.appendChild(canvas);

    const uniforms = {
      uBase: { value: null as THREE.Texture | null },
      uDepth: { value: null as THREE.Texture | null },
      uAtlas: { value: null as THREE.Texture | null },
      uView: { value: new THREE.Vector4(0, 0, 1, 1) },
      uOffset: { value: new THREE.Vector2() },
      uScale: { value: 1 },
      uSat: { value: 1 },
      uBottomFade: { value: 1 },
      uDst: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector4()) },
      uSrc: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector4()) },
      uW: { value: new Array<number>(MAX_LAYERS).fill(0) },
    };
    const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, premultipliedAlpha: true, depthTest: false });
    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry, material);
    const scene = new THREE.Scene();
    scene.add(mesh);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const textures: THREE.Texture[] = [];
    let manifest: RigManifest | null = null;
    let layerIndex: Partial<Record<LayerName, number>> = {};

    // 尺寸与构图
    const layout = () => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      renderer.setSize(r.width, r.height, false);
      if (manifest) {
        const v = viewRect(latest.current.framing, manifest.size[0] / manifest.size[1], r.width / r.height, manifest.face);
        uniforms.uView.value.set(v[0], v[1], v[2], v[3]);
        uniforms.uBottomFade.value = latest.current.framing === "bust" ? 1 : 0;
      }
    };
    const ro = new ResizeObserver(layout);
    ro.observe(el);

    // 可见性：离开视口或页面隐藏时停止逐帧渲染
    let inView = true;
    const io = new IntersectionObserver(([e]) => {
      inView = e.isIntersecting;
      schedule();
    });
    io.observe(el);
    const onVisibility = () => schedule();
    document.addEventListener("visibilitychange", onVisibility);

    // 指针：归一化到容器中心，3 s 无移动回到正前方
    let pointer: { x: number; y: number } | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const span = Math.max(window.innerWidth, window.innerHeight) * 0.5;
      pointer = {
        x: Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / span)),
        y: Math.max(-1, Math.min(1, -(e.clientY - (r.top + r.height * 0.3)) / span)),
      };
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => (pointer = null), 3000);
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const animator = createRigAnimator();
    greet.current = () => animator.greet();
    const onClick = () => latest.current.interactive && animator.greet();
    el.addEventListener("click", onClick);

    const smoother = createSmoother();
    let spectrum: Uint8Array<ArrayBuffer> | null = null;
    const fps = createFpsMonitor();
    let lowFpsReported = false;
    let last = performance.now();
    let clock = 0;

    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      clock += dt;
      const p = latest.current;
      const s = p.signals;
      let target = zeroVisemes();
      if (p.state === "speaking") {
        const analyser = s?.analyser?.() ?? null;
        if (s?.pseudoSpeaking?.() || !analyser) target = pseudoVisemes(clock);
        else {
          if (!spectrum || spectrum.length !== analyser.frequencyBinCount) spectrum = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(spectrum);
          target = visemesFromSpectrum(spectrum, analyser.context.sampleRate);
        }
      }
      const visemes = smoother.next(target, dt);
      const f = animator.step(dt, { state: p.state, visemes, mic: s?.micLevel?.() ?? 0, pointer });
      for (const [name, i] of Object.entries(layerIndex) as [LayerName, number][]) uniforms.uW.value[i] = f.weights[name];
      uniforms.uOffset.value.set(f.offset[0], f.offset[1]);
      uniforms.uScale.value = f.scale;
      uniforms.uSat.value = f.saturation;
      renderer.render(scene, camera);
      if (fps.tick(dt) && !lowFpsReported) {
        lowFpsReported = true;
        p.onLowFps?.();
      }
      schedule();
    };
    function schedule() {
      if (disposed || raf || !manifest) return;
      if (!inView || document.visibilityState !== "visible") return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }

    const id = props.character;
    Promise.all([
      loadManifest(id),
      loadTexture(avatarAssetUrl(id, "base.webp")),
      loadTexture(avatarAssetUrl(id, "depth.webp")),
      loadTexture(avatarAssetUrl(id, "atlas.webp")),
    ]).then(
      ([m, base, depth, atlas]) => {
        textures.push(base, depth, atlas);
        if (disposed) return;
        manifest = m;
        uniforms.uBase.value = base;
        uniforms.uDepth.value = depth;
        uniforms.uAtlas.value = atlas;
        layerIndex = {};
        m.layers.slice(0, MAX_LAYERS).forEach((l, i) => {
          uniforms.uDst.value[i].set(...l.dst);
          uniforms.uSrc.value[i].set(...l.src);
          layerIndex[l.name] = i;
        });
        layout();
        renderer.render(scene, camera);
        latest.current.onReady?.();
        schedule();
      },
      () => !disposed && latest.current.onError?.(),
    );

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearTimeout(idleTimer);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onMove);
      el.removeEventListener("click", onClick);
      greet.current = null;
      textures.forEach((t) => t.dispose());
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
    // 只有换形象才重建；其他属性通过 latest 逐帧读取
  }, [props.character]);

  return <div ref={host} className="size-full" style={{ cursor: props.interactive ? "pointer" : undefined }} aria-hidden />;
}
