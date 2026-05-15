import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { StreamingWavPlayer } from '../lib/streaming-wav-player';

// MARK: - Simplex 3D noise (used by the disc shader's edge warp)

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

// MARK: - Plasma shader (Gemini "Slo-Mo AI Fractal Orb")
//
// Direct port of gemini-code-1777937734401.html: a screen-aligned plane runs
// rays from a fixed eye point through each fragment, marching the union of an
// orb SDF (chained-sine fractal noise subtracted from a sphere) and a horizontal
// beam SDF that creates the lateral transmission lines. Three color stops
// (purple body, cyan sheen, white filaments) accumulated additively per step.

const PLASMA_VERT = `
varying vec3 vPosition;
void main() {
  vPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PLASMA_FRAG = `
uniform float uTime;
uniform float uIntensity;
varying vec3 vPosition;

mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1,0,0,0,c,-s,0,s,c); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c,0,s,0,1,0,-s,0,c); }

float getBeam(vec3 p) {
  float beamSDF = length(p.yz) - 0.08;
  vec3 q = p * vec3(0.4, 2.0, 1.0) + (uTime * 0.1);
  float noise = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    noise += amp * abs(sin(q.x + sin(q.y + sin(q.z))));
    q *= 1.8;
    amp *= 0.5;
  }
  return beamSDF - noise * 0.08;
}

float map(vec3 p) {
  float res = length(p) - 1.1;
  vec3 q = p * 1.2 + (uTime * 0.1);
  float f = 0.0;
  float amp = 0.5 + (uIntensity * 0.4);
  for (int i = 0; i < 6; i++) {
    q = rotY(uTime * 0.02) * q;
    f += amp * abs(sin(q.x + sin(q.y + sin(q.z))));
    q *= 1.7;
    amp *= 0.5;
  }
  float orb = res - f * (0.3 + uIntensity * 0.2);
  return min(orb, getBeam(p));
}

void main() {
  vec3 ro = vec3(0, 0, 3);
  vec3 rd = normalize(vec3(vPosition.xy, -1.8));

  float t = 0.0;
  vec3 col = vec3(0.0);

  for (int i = 0; i < 50; i++) {
    vec3 p = ro + rd * t;
    float d = map(p);
    if (t > 5.0) break;

    float glow = 0.015 / (0.015 + abs(d));

    vec3 purple = vec3(0.7, 0.0, 1.0) * glow;
    vec3 cyan = vec3(0.2, 0.8, 1.0) * pow(glow, 2.5);
    vec3 white = vec3(1.0) * pow(glow, 10.0) * uIntensity;

    col += (purple * 0.12) + (cyan * 0.15) + (white * 0.1);
    t += max(abs(d) * 0.5, 0.02);
  }

  float dist = length(vPosition.xy);
  col *= smoothstep(1.5, 0.8, dist);

  gl_FragColor = vec4(col, 1.0);
}
`;

// MARK: - Component

interface OrbProps {
  /** Active StreamingWavPlayer for FFT amplitude readout. */
  playerRef: React.RefObject<StreamingWavPlayer | null>;
  /** True while LLM is streaming or TTS is playing. */
  isActive: boolean;
}

export function Orb({ playerRef, isActive }: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // MARK: Renderer — match Gemini exactly. No tonemapping, no env map, no
    // postprocessing. The carefully tuned RGB values in the shader pass straight
    // through to the framebuffer.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // MARK: Scene + camera — match Gemini (45 fov, z=4).
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.z = 4;

    // MARK: Plasma — Gemini's screen-aligned plane raymarcher.
    const plasmaUniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 0.2 },
    };
    const plasmaMat = new THREE.ShaderMaterial({
      uniforms: plasmaUniforms,
      vertexShader: PLASMA_VERT,
      fragmentShader: PLASMA_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
    });
    const plasmaGeom = new THREE.PlaneGeometry(5, 5);
    const plasma = new THREE.Mesh(plasmaGeom, plasmaMat);
    scene.add(plasma);

    // MARK: Ice-blue disc. Disabled — kept in code for future re-enable.
    const discGeom = new THREE.CircleGeometry(0.834, 200);
    const discMat = new THREE.ShaderMaterial({
      uniforms: { u_time: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      vertexShader: `
        varying vec2 vLocalPos;
        void main() {
          vLocalPos = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        ${SIMPLEX_3D}
        uniform float u_time;
        varying vec2 vLocalPos;
        void main() {
          float DISC_R = 0.834;
          float r = length(vLocalPos);
          float theta = atan(vLocalPos.y, vLocalPos.x);
          float n_a = snoise(vec3(cos(theta) * 1.0, sin(theta) * 1.0, u_time * 0.165));
          float n_b = snoise(vec3(cos(theta) * 2.0, sin(theta) * 2.0, u_time * 0.110)) * 0.35;
          float warp = (n_a + n_b) * 0.05;
          float effectiveR = DISC_R + warp;
          if (r > effectiveR) discard;
          float radial = clamp(r / effectiveR, 0.0, 1.0);
          float edge = pow(radial, 33.0);
          vec3 iceBlue = vec3(0.55, 0.85, 1.10);
          vec3 bodyTint = vec3(0.30, 0.50, 0.85);
          vec3 col = mix(bodyTint, iceBlue, edge);
          float alpha = mix(0.02, 0.95, edge);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    const disc = new THREE.Mesh(discGeom, discMat);
    disc.renderOrder = 2;
    disc.position.z = 0.5;
    disc.visible = true;
    scene.add(disc);

    // MARK: Resize
    const resize = () => {
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // MARK: Animation loop — Gemini's slow timebase (time * 0.0004), with
    // audio amplitude driving uIntensity in place of Gemini's slider.
    const fftBins = 64;
    const dataArray = new Uint8Array(fftBins);
    let smoothAmp = 0;
    let raf = 0;

    const tick = (timeMs: number) => {
      // Voice activity amplitude (0..1)
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

      // Match Gemini's slow timebase. Idle uIntensity baseline (0.2) keeps the
      // filaments visible when there's no audio, then audio energy lifts it.
      plasmaUniforms.uTime.value = timeMs * 0.0004;
      plasmaUniforms.uIntensity.value = 0.2 + smoothAmp * 0.8;

      discMat.uniforms.u_time.value = timeMs / 1000;
      // Disc expands with audio amplitude — same driver as the plasma's energy.
      // 1.0 idle, up to 1.15 at peak.
      disc.scale.setScalar(1.0 + smoothAmp * 0.15);

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      plasmaGeom.dispose();
      plasmaMat.dispose();
      discGeom.dispose();
      discMat.dispose();
      renderer.dispose();
    };
  }, [playerRef]);

  return <canvas ref={canvasRef} className="w-full h-full block" style={{ display: 'block' }} />;
}
