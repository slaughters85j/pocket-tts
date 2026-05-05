import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { StreamingWavPlayer } from '../lib/streaming-wav-player';

// MARK: - Inner plasma shaders
//
// The inner plasma is a horizontally-stretched ellipsoid with custom shader.
// Body is purple-magenta. Horizontal tips are emissive white. Refracted by
// the glass shell, those tips become the white "spike" lateral artifacts.
// There are no external point lights. The brightness is the plasma itself.

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

    // MARK: Renderer
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      premultipliedAlpha: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.setClearColor(0x000000, 1);

    // MARK: Scene + camera
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0, 4.0);

    // MARK: Environment map. Drives glossy reflections on the plasma metal.
    // Per-material envMapIntensity lets us dim it on the shell separately.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;
    scene.environmentIntensity = 0.35;

    // MARK: Cosmic ribbons. Three thin glass torus bands at different orientations
    // around the plasma core. A vertex-shader wave deforms each ribbon over time
    // so they bend and flex like elastic ribbons flowing through spacetime.
    // Glass material gives transmission, refraction, and edge highlights.
    const ribbonUniforms = {
      u_time: { value: 0 },
      u_amp: { value: 0 },
    };
    const ribbonMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      transmission: 1.0,
      thickness: 0.05,
      roughness: 0.04,
      ior: 1.42,
      transparent: true,
      clearcoat: 1.0,
      clearcoatRoughness: 0.0,
      envMapIntensity: 1.0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    ribbonMat.onBeforeCompile = (shader) => {
      shader.uniforms.u_time = ribbonUniforms.u_time;
      shader.uniforms.u_amp = ribbonUniforms.u_amp;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
${SIMPLEX_3D}
uniform float u_time;
uniform float u_amp;
varying vec3 vRibbonWorldPos;`,
      ).replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
float n_a = snoise(position * 1.2 + vec3(u_time * 0.30));
float n_b = snoise(position * 2.5 - vec3(u_time * 0.21)) * 0.5;
transformed += normal * (n_a + n_b) * (0.04 + u_amp * 0.06);
vRibbonWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
      // Time-varying Fresnel accents. Three colors (electric blue, gold, rust)
      // cycle on 120-degree-offset sinusoids. Phase is driven by world position
      // so each ribbon and each section transitions independently and never in
      // sync, producing a natural non-uniform shimmer along the edges.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
uniform float u_time;
varying vec3 vRibbonWorldPos;`,
      ).replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
vec3 vDir = normalize(vViewPosition);
float fres = pow(1.0 - max(dot(normalize(vNormal), vDir), 0.0), 2.2);

float phase = u_time * 0.18 + vRibbonWorldPos.x * 1.30 + vRibbonWorldPos.y * 0.85;
vec3 blueEdge = vec3(0.20, 0.80, 1.50);
vec3 goldEdge = vec3(1.10, 0.65, 0.18);
vec3 rustEdge = vec3(0.45, 0.15, 0.05);

float w1 = sin(phase) * 0.5 + 0.5;
float w2 = sin(phase + 2.094) * 0.5 + 0.5;
float w3 = sin(phase + 4.189) * 0.5 + 0.5;
float wsum = w1 + w2 + w3 + 0.001;
vec3 accent = (blueEdge * w1 + goldEdge * w2 + rustEdge * w3) / wsum;

totalEmissiveRadiance += accent * fres * 0.15;`,
      ).replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
float edgeAlpha = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewPosition)), 0.0), 3.5);
gl_FragColor.a = mix(0.08, 1.0, edgeAlpha);`,
      );
    };
    // Shared geometry, four instances at different orientations.
    const ribbonGeom = new THREE.TorusGeometry(1.25, 0.2, 24, 200);
    const ribbon1 = new THREE.Mesh(ribbonGeom, ribbonMat);
    const ribbon2 = new THREE.Mesh(ribbonGeom, ribbonMat);
    const ribbon3 = new THREE.Mesh(ribbonGeom, ribbonMat);
    const ribbon4 = new THREE.Mesh(ribbonGeom, ribbonMat);
    // ribbon1 — horizontal equator (flat torus, no rotation)
    ribbon1.rotation.set(0, 0, 0);
    // ribbon2 — VERTICAL ribbon. Torus rotated 90° about X reads as an upright
    // band crossing the orb top-to-bottom. (Upper red arrow in reference.)
    ribbon2.rotation.set(0, 0, 0);;
    // ribbon3 — VERTICAL-ish diagonal ribbon. Combined X/Y/Z tilt makes it
    // sweep down-and-around like an inclined meridian. (Lower red arrow.)
    ribbon3.rotation.set(0, 0, 0);;
    // ribbon4 — secondary diagonal ribbon, mirror-tilted from ribbon3.
    ribbon4.rotation.set(Math.PI / 6, -Math.PI / 4, Math.PI / 3);
    ribbon3.scale.setScalar(0.88);
    ribbon4.scale.setScalar(0.95);
    scene.add(ribbon1, ribbon2, ribbon3, ribbon4);

    // MARK: Inner plasma. Raymarched volumetric singularity. The mesh is a
    // bounding box; the front face is the ray entry and the fragment shader
    // marches a chained-sine noise field along the view ray, accumulating
    // color from our 15-stop gradient at multiple intensity powers.
    //
    // Technique inspired by Gemini's raymarched orb experiments: iterative
    // chained-sine noise gives the vein/turbulence patterns, soft-glow
    // accumulation `0.015/(0.015+|d|)` gives the cloud-edge feel, layered
    // color powers stack a hot core inside a broader halo. Slow time evolution
    // keeps it meditative instead of jittery.
    const plasmaUniforms = {
      u_time: { value: 0 },
      u_amp: { value: 0 },
    };

    // MARK: Inner orb. Direct port of the gemini "Slo-Mo AI Fractal Orb"
    // raymarcher: a screen-aligned plane runs a ray from a fixed local-space
    // eye point, marching the union of an orb SDF (chained-sine fractal noise
    // subtracted from a sphere) and a horizontal "beam" SDF that creates the
    // lateral intersection points extending left and right from the orb. A
    // small white-emission baseline keeps those lateral intersections visible
    // even when there's no audio.
    const PLASMA_VERT = `
varying vec3 vPosition;
void main() {
  vPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

    const PLASMA_FRAG = `
uniform float u_time;
uniform float u_amp;
varying vec3 vPosition;

mat3 rotX(float a) { float c = cos(a); float s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c); }
mat3 rotY(float a) { float c = cos(a); float s = sin(a); return mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c); }

// Horizontal beam SDF. Tube along X (length(p.yz)) with chained-sine noise on
// horizontally-stretched coordinates so the noise reads as long lateral veins
// extending out from the central orb. Subtracting the noise widens the tube
// non-uniformly along its length.
float getBeam(vec3 p) {
  float beamSDF = length(p.yz) - 0.08;
  vec3 q = p * vec3(0.4, 2.0, 1.0) + (u_time * 0.04);
  float noise = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    noise += amp * abs(sin(q.x + sin(q.y + sin(q.z))));
    q *= 1.8;
    amp *= 0.5;
  }
  return beamSDF - noise * 0.08;
}

// Combined orb + horizontal beam. Orb is sphere(1.1) with chained-sine fractal
// noise subtracted (slow rotY twist on the sample coords). Union with the beam
// produces the lateral intersection structure extending left and right.
float mapField(vec3 p) {
  float res = length(p) - 1.1;

  vec3 q = p * 1.2 + (u_time * 0.04);
  float f = 0.0;
  float amp = 0.5 + (u_amp * 0.4);
  for (int i = 0; i < 6; i++) {
    q = rotY(u_time * 0.008) * q;
    f += amp * abs(sin(q.x + sin(q.y + sin(q.z))));
    q *= 1.7;
    amp *= 0.5;
  }
  float orb = res - f * (0.3 + u_amp * 0.2);

  return min(orb, getBeam(p));
}

void main() {
  // Screen-space raymarch: eye at +Z, rays into -Z through the plane's local
  // position. Plane is treated as the screen.
  vec3 ro = vec3(0.0, 0.0, 3.0);
  vec3 rd = normalize(vec3(vPosition.xy, -1.8));

  float t = 0.0;
  vec3 col = vec3(0.0);

  for (int i = 0; i < 50; i++) {
    vec3 p = ro + rd * t;
    float d = mapField(p);
    if (t > 5.0) break;

    // Cloud-edge soft glow accumulator: bright where the SDF is near zero.
    float glow = 0.015 / (0.015 + abs(d));

    // Plasma body: deep purple #6b1fb8 → magenta #d946ef. Mix factor tied to
    // glow so denser SDF samples lean magenta, diffuse falloff stays purple.
    vec3 plasmaA = vec3(0.4196, 0.1216, 0.7216); // #6b1fb8
    vec3 plasmaB = vec3(0.8510, 0.2745, 0.9373); // #d946ef
    vec3 plasma  = mix(plasmaA, plasmaB, clamp(glow * 1.3, 0.0, 1.0)) * glow;

    // Outer bloom shell — cyan #67e8f9, tighter falloff than the body.
    vec3 outerBloom = vec3(0.4039, 0.9098, 0.9765) * pow(glow, 2.5);

    // Hot white core — the lateral intersection hotspots. Small baseline so
    // they stay visible at idle, then audio energy lifts.
    vec3 white = vec3(1.0) * pow(glow, 10.0) * (0.08 + u_amp * 0.50);

    col += (plasma * 0.12) + (outerBloom * 0.15) + (white * 0.10);
    t += max(abs(d) * 0.5, 0.02);
  }

  // Plane corners fade to black so the rectangular boundary is invisible.
  float dist = length(vPosition.xy);
  col *= smoothstep(1.5, 0.8, dist);

  // Halo — soft cyan glow extending beyond the orb silhouette. Inner color
  // #06b6d4 closer in, outer color #0891b2 farther out. Peak intensity sits
  // around r ≈ 1.0 (just outside the orb's 1.1 SDF radius).
  vec3 haloInner = vec3(0.0235, 0.7137, 0.8314); // #06b6d4
  vec3 haloOuter = vec3(0.0314, 0.5686, 0.6980); // #0891b2
  float haloMask = smoothstep(0.7, 1.05, dist) * smoothstep(1.55, 1.05, dist);
  vec3 haloColor = mix(haloInner, haloOuter, smoothstep(0.9, 1.45, dist));
  col += haloColor * haloMask * 0.12;

  gl_FragColor = vec4(col, 1.0);
}
`;

    const plasmaMat = new THREE.ShaderMaterial({
      uniforms: plasmaUniforms,
      vertexShader: PLASMA_VERT,
      fragmentShader: PLASMA_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    // Screen-aligned 5×5 plane. Camera sits at +Z; the plane defaults to facing
    // +Z, so no rotation needed. Smoothstep vignette in the shader hides the
    // rectangular silhouette inside the visible viewport.
    const plasmaGeom = new THREE.PlaneGeometry(5, 5);
    const plasma = new THREE.Mesh(plasmaGeom, plasmaMat);
    plasma.renderOrder = -1;
    scene.add(plasma);

    // MARK: Postprocessing. Modest bloom so tips spike but body keeps color.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(canvas.clientWidth, canvas.clientHeight),
      0.16, // strength
      0.40, // radius
      0.97, // threshold — only near-white peaks bloom, kills the body wash-out
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    // MARK: Resize
    const resize = () => {
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      bloom.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // MARK: Animation loop. Speaking-mode only. Audio amplitude is the sole driver.
    // Capped at 30 Hz to keep GPU load bounded on high-refresh displays.
    const start = performance.now();
    const fftBins = 64;
    const dataArray = new Uint8Array(fftBins);
    let smoothAmp = 0;
    let raf = 0;

    const tick = () => {
      const t = (performance.now() - start) / 1000;

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

      // Plasma uniforms drive vertex displacement and HDR tip emissive.
      // No rotation: surface evolves in place via time-driven noise so it reads
      // as fluid flow rather than a spinning solid.
      plasmaUniforms.u_time.value = t;
      plasmaUniforms.u_amp.value = smoothAmp;

      // Ribbon uniforms drive their wave deformation independently.
      ribbonUniforms.u_time.value = t;
      ribbonUniforms.u_amp.value = smoothAmp;

      // Slow orbital drift on each ribbon so they mutate into and out of each
      // other rather than holding fixed orientations. Different frequencies per
      // ribbon and per axis ensure they never settle into a repeating pattern.
      ribbon1.rotation.x = Math.sin(t * 0.07) * 0.35;
      ribbon1.rotation.z = t * 0.03 + Math.cos(t * 0.11) * 0.20;
      ribbon2.rotation.x = Math.PI / 2 + Math.sin(t * 0.09) * 0.40;
      ribbon2.rotation.y = Math.cos(t * 0.06) * 0.25;
      // ribbon3.rotation.x — set ribbon3's X-axis rotation in radians, every frame.
      //   Math.PI / 1     → base tilt of π rad (180°). Equivalent to Math.PI;
      //                     dividing by 1 is a no-op kept for symmetry with the
      //                     other "Math.PI / N" lines around it.
      //   Math.sin(t * 0.10) → slow oscillator. `t` is seconds since mount; 0.10 is
      //                     the angular frequency, so one full sine cycle takes
      //                     2π / 0.10 ≈ 62.8 seconds. Output is in [-1, 1].
      //   * 0.45          → wobble amplitude in radians (~25.8°). The sine output
      //                     is scaled to ±0.45 rad around the base.
      // Net effect: ribbon3 sits flipped 180° around X, slowly wobbling ±25.8°
      // through that axis with a ~63-second period.
      ribbon3.rotation.x = Math.PI / 1 + Math.sin(t * 0.10) * 0.45;
      ribbon3.rotation.y = Math.PI / 1 + Math.cos(t * 0.13) * 0.35;
      ribbon3.rotation.z = Math.PI / 6 + Math.sin(t * 0.08) * 0.30;
      ribbon4.rotation.x = Math.PI / 6 + Math.cos(t * 0.12) * 0.40;
      ribbon4.rotation.y = -Math.PI / 4 + Math.sin(t * 0.05) * 0.32;
      ribbon4.rotation.z = Math.PI / 3 + Math.cos(t * 0.09) * 0.28;

      composer.render();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      ribbonGeom.dispose();
      ribbonMat.dispose();
      plasmaGeom.dispose();
      plasmaMat.dispose();
      envTexture.dispose();
      pmrem.dispose();
      composer.dispose();
      renderer.dispose();
    };
  }, [playerRef]);

  return <canvas ref={canvasRef} className="w-full h-full block" style={{ display: 'block' }} />;
}
