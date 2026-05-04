import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { StreamingWavPlayer } from '../lib/streaming-wav-player';

// MARK: - Plasma shaders

// 3D simplex noise — Ashima Arts / Stefan Gustavson, MIT.
const SIMPLEX_3D = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

// Glass shell — fresnel-only, cyan rim, transparent center, additive.
const SHELL_VERTEX = `
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHELL_FRAGMENT = `
uniform float u_amp;
uniform float u_active;
varying vec3 vNormal;
varying vec3 vWorldPos;

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float fres   = pow(1.0 - max(dot(vNormal, viewDir), 0.0), 2.5);

  vec3 cyanRim = vec3(0.40, 0.91, 1.00);   // #67e8f9 ish
  vec3 col     = cyanRim * fres;
  float a      = fres * (0.55 + u_active * 0.20 + u_amp * 0.15);

  gl_FragColor = vec4(col, a);
}
`;

// Inner plasma — magenta-purple volumetric blob, additive, soft falloff at silhouette.
const PLASMA_VERTEX = `
${SIMPLEX_3D}

uniform float u_time;
uniform float u_amp;

varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vNoise;

void main() {
  // 3D noise — slow base evolution, audio amplifies the second octave.
  vec3 q = position * 1.4;
  float n1 = snoise(q + vec3(u_time * 0.20));
  float n2 = snoise(q * 2.1 - vec3(u_time * 0.14)) * 0.55;
  float n  = n1 + n2;
  vNoise = n;

  float ampl = 0.06 + u_amp * 0.30;
  vec3 displaced = position + normal * n * ampl;

  vNormal   = normalize(normalMatrix * normal);
  vec4 wp   = modelMatrix * vec4(displaced, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const PLASMA_FRAGMENT = `
uniform float u_amp;

varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vNoise;

void main() {
  // Inverse fresnel — opaque facing the camera, fades to zero at silhouette so
  // the plasma never reaches the shell edge. This is the key to "volumetric blob".
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float facing = max(dot(vNormal, viewDir), 0.0);
  float a      = pow(facing, 1.6) * 0.85;

  // Color — deep purple (#6b1fb8) → magenta (#d946ef) driven by the noise field.
  vec3 deepPurple = vec3(0.42, 0.12, 0.72);
  vec3 magenta    = vec3(0.85, 0.27, 0.94);
  float t = clamp(vNoise * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(deepPurple, magenta, t);

  col *= 1.0 + u_amp * 0.45;

  gl_FragColor = vec4(col * a, a);
}
`;

// MARK: - Helpers

function makeRadialTexture(stops: Array<[number, string]>, size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [pos, color] of stops) grad.addColorStop(pos, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface NodeRefs {
  group: THREE.Group;
  core: THREE.Mesh;
  halo: THREE.Sprite;
  haloTex: THREE.CanvasTexture;
}

function makeEquatorialNode(x: number): NodeRefs {
  const group = new THREE.Group();

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 16, 16),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  group.add(core);

  const haloTex = makeRadialTexture([
    [0.0, 'rgba(255, 255, 255, 0.95)'],
    [0.25, 'rgba(217, 70, 239, 0.55)'],
    [0.55, 'rgba(103, 232, 249, 0.30)'],
    [1.0, 'rgba(103, 232, 249, 0.0)'],
  ]);
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: haloTex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  halo.scale.set(0.55, 0.55, 1);
  group.add(halo);

  group.position.set(x, 0, 0);
  return { group, core, halo, haloTex };
}

// MARK: - Component

interface OrbProps {
  /** Ref to the active StreamingWavPlayer (re-created per chat message). */
  playerRef: React.RefObject<StreamingWavPlayer | null>;
  /** Whether the assistant is currently active (LLM streaming or TTS playing). */
  isActive: boolean;
}

export function Orb({ playerRef, isActive }: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // MARK: Renderer
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x000000, 0);

    // MARK: Scene + camera
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0, 4.0);
    camera.lookAt(0, 0, 0);

    // MARK: Layer 1 — background cyan radial bloom
    const bgTex = makeRadialTexture([
      [0.0, 'rgba(6, 182, 212, 0.18)'],
      [0.5, 'rgba(6, 182, 212, 0.06)'],
      [1.0, 'rgba(0, 0, 0, 0.0)'],
    ]);
    const bg = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: bgTex,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        transparent: true,
      }),
    );
    bg.scale.set(6.0, 6.0, 1);
    bg.position.z = -1.2;
    bg.renderOrder = 0;
    scene.add(bg);

    // MARK: Layer 2 — outer halo (breathing at ~0.3 Hz)
    const haloTex = makeRadialTexture([
      [0.0, 'rgba(103, 232, 249, 0.50)'],
      [0.3, 'rgba(8, 145, 178, 0.25)'],
      [1.0, 'rgba(8, 145, 178, 0.0)'],
    ]);
    const haloMat = new THREE.SpriteMaterial({
      map: haloTex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.5,
    });
    const halo = new THREE.Sprite(haloMat);
    halo.scale.set(3.4, 3.4, 1);
    halo.renderOrder = 1;
    scene.add(halo);

    // MARK: Layer 3 — glass shell (custom fresnel shader)
    const shellUniforms = {
      u_amp: { value: 0 },
      u_active: { value: 0 },
    };
    const shellMat = new THREE.ShaderMaterial({
      uniforms: shellUniforms,
      vertexShader: SHELL_VERTEX,
      fragmentShader: SHELL_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1.0, 96, 96), shellMat);
    shell.renderOrder = 3;
    scene.add(shell);

    // MARK: Layer 4 — inner plasma core
    const plasmaUniforms = {
      u_time: { value: 0 },
      u_amp: { value: 0 },
    };
    const plasmaMat = new THREE.ShaderMaterial({
      uniforms: plasmaUniforms,
      vertexShader: PLASMA_VERTEX,
      fragmentShader: PLASMA_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const plasma = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 6), plasmaMat);
    plasma.renderOrder = 2;
    scene.add(plasma);

    // MARK: Layer 5 — two equatorial nodes (left and right)
    const nodeL = makeEquatorialNode(-1.02);
    const nodeR = makeEquatorialNode(1.02);
    nodeL.group.renderOrder = 5;
    nodeR.group.renderOrder = 5;
    scene.add(nodeL.group);
    scene.add(nodeR.group);

    // MARK: Layer 6 — faint meridian bands (concentric inner-shell hint)
    const bandMat = new THREE.MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.10,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const bands: THREE.Mesh[] = [];
    [
      { rx: 0.0, ry: 0.0 },
      { rx: Math.PI / 5, ry: 0.0 },
      { rx: 0.0, ry: Math.PI / 5 },
    ].forEach(({ rx, ry }) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.004, 8, 160), bandMat);
      ring.rotation.x = rx;
      ring.rotation.y = ry;
      ring.renderOrder = 4;
      scene.add(ring);
      bands.push(ring);
    });

    // MARK: Postprocessing — selective bloom on bright pixels
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(canvas.clientWidth, canvas.clientHeight),
      0.55, // strength
      0.50, // radius
      0.55, // threshold — nodes / shell rim bloom, plasma body doesn't
    );
    composer.addPass(bloomPass);

    // MARK: Resize
    const resize = () => {
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      bloomPass.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // MARK: Animation loop
    const start = performance.now();
    const fftBins = 64;
    const dataArray = new Uint8Array(fftBins);
    let smoothAmp = 0;
    let smoothActive = 0;
    let raf = 0;

    const tick = () => {
      const t = (performance.now() - start) / 1000;

      // Audio amplitude (0..1 voice activity)
      let rawAmp = 0;
      const player = playerRef.current;
      if (player && !player.isStopped) {
        const analyser = player.getAnalyser();
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < fftBins; i++) sum += dataArray[i];
        rawAmp = sum / (fftBins * 255);
      }
      smoothAmp += (rawAmp - smoothAmp) * 0.20;
      smoothActive += ((isActiveRef.current ? 1 : 0) - smoothActive) * 0.05;

      // Layer 2 — halo: 0.3 Hz idle breathing + active bump + amp lift
      const breath = 0.5 + 0.5 * Math.sin(t * Math.PI * 2.0 * 0.3);
      haloMat.opacity = 0.20 + breath * 0.18 + smoothActive * 0.30 + smoothAmp * 0.30;

      // Layer 3 — shell: amp + active boost the rim
      shellUniforms.u_amp.value = smoothAmp;
      shellUniforms.u_active.value = smoothActive;

      // Layer 4 — plasma: noise evolves on its own; amp drives displacement
      plasmaUniforms.u_time.value = t;
      plasmaUniforms.u_amp.value = smoothAmp;
      plasma.rotation.y = -t * 0.10;
      plasma.rotation.x = Math.sin(t * 0.13) * 0.20;

      // Layer 5 — nodes: idle pulse at 1 Hz when listening, amp drives during speech
      const nodePulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2.0 * 1.0);
      const nodeBright =
        0.35 + smoothActive * 0.30 * nodePulse + smoothAmp * 0.55;
      const nodeHaloScale = 0.55 + smoothAmp * 0.25 + smoothActive * 0.10 * nodePulse;
      [nodeL, nodeR].forEach((n) => {
        (n.core.material as THREE.MeshBasicMaterial).opacity = Math.min(nodeBright, 1.0);
        n.halo.material.opacity = Math.min(nodeBright * 0.8, 1.0);
        n.halo.scale.set(nodeHaloScale, nodeHaloScale, 1);
      });

      // Layer 6 — bands: very slow drift to imply concentric inner shells
      bands[0].rotation.z = t * 0.05;
      bands[1].rotation.z = -t * 0.04;
      bands[2].rotation.z = t * 0.03;

      composer.render();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      shell.geometry.dispose();
      shellMat.dispose();
      plasma.geometry.dispose();
      plasmaMat.dispose();
      bands.forEach((b) => b.geometry.dispose());
      bandMat.dispose();
      [nodeL, nodeR].forEach((n) => {
        n.core.geometry.dispose();
        (n.core.material as THREE.MeshBasicMaterial).dispose();
        (n.halo.material as THREE.SpriteMaterial).dispose();
        n.haloTex.dispose();
      });
      bgTex.dispose();
      (bg.material as THREE.SpriteMaterial).dispose();
      haloTex.dispose();
      haloMat.dispose();
      composer.dispose();
      renderer.dispose();
    };
  }, [playerRef]);

  return <canvas ref={canvasRef} className="w-full h-full block" style={{ display: 'block' }} />;
}
