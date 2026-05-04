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
    scene.environmentIntensity = 1.0;

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
      thickness: 0.25,
      roughness: 0.04,
      ior: 1.42,
      transparent: true,
      clearcoat: 1.0,
      clearcoatRoughness: 0.0,
      envMapIntensity: 0.7,
      side: THREE.DoubleSide,
    });
    ribbonMat.onBeforeCompile = (shader) => {
      shader.uniforms.u_time = ribbonUniforms.u_time;
      shader.uniforms.u_amp = ribbonUniforms.u_amp;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
${SIMPLEX_3D}
uniform float u_time;
uniform float u_amp;`,
      ).replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
float n_a = snoise(position * 1.2 + vec3(u_time * 0.30));
float n_b = snoise(position * 2.5 - vec3(u_time * 0.21)) * 0.5;
transformed += normal * (n_a + n_b) * (0.04 + u_amp * 0.06);`,
      );
      // Fresnel-driven warm metal accents on ribbon edges. Glancing angles get
      // gold, deeper view directions get rust. Subtle HDR so they bloom faintly.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
vec3 vDir = normalize(vViewPosition);
float fres = pow(1.0 - max(dot(normalize(vNormal), vDir), 0.0), 2.2);
vec3 goldEdge = vec3(1.30, 0.78, 0.22);
vec3 rustEdge = vec3(0.55, 0.18, 0.05);
totalEmissiveRadiance += mix(rustEdge, goldEdge, fres) * fres * 0.65;`,
      );
    };
    // Shared geometry, three instances at different orientations.
    const ribbonGeom = new THREE.TorusGeometry(1.05, 0.025, 24, 240);
    const ribbon1 = new THREE.Mesh(ribbonGeom, ribbonMat);
    const ribbon2 = new THREE.Mesh(ribbonGeom, ribbonMat);
    const ribbon3 = new THREE.Mesh(ribbonGeom, ribbonMat);
    ribbon1.rotation.set(0, 0, 0);
    ribbon2.rotation.set(Math.PI / 2, 0, 0);
    ribbon3.rotation.set(Math.PI / 4, Math.PI / 3, Math.PI / 6);
    ribbon3.scale.setScalar(0.88);
    scene.add(ribbon1, ribbon2, ribbon3);

    // MARK: Inner plasma. Six thin metallic torus bands at different orientations
    // form an interwoven core that mutates without becoming a smooth blob. Strong
    // saturation and high iridescence give a vivid color palette. Bright HDR
    // emissive at world-space X poles produces the lateral spikes.
    const plasmaUniforms = {
      u_time: { value: 0 },
      u_amp: { value: 0 },
    };
    const plasmaMat = new THREE.MeshPhysicalMaterial({
      color: 0x8822dd,
      metalness: 0.85,
      roughness: 0.13,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      iridescence: 0.95,
      iridescenceIOR: 1.45,
      iridescenceThicknessRange: [180, 880],
      envMapIntensity: 1.8,
    });
    plasmaMat.onBeforeCompile = (shader) => {
      shader.uniforms.u_time = plasmaUniforms.u_time;
      shader.uniforms.u_amp = plasmaUniforms.u_amp;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
${SIMPLEX_3D}
uniform float u_time;
uniform float u_amp;
varying vec3 vWorldPosition;`,
      ).replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
float n_a = snoise(position * 1.6 + vec3(u_time * 0.22));
float n_b = snoise(position * 3.4 - vec3(u_time * 0.16)) * 0.45;
float n_c = snoise(position * 6.2 + vec3(u_time * 0.10)) * 0.20;
transformed += normal * (n_a + n_b + n_c) * (0.05 + u_amp * 0.10);
vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
uniform float u_amp;
varying vec3 vWorldPosition;`,
      ).replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
float xNorm = abs(vWorldPosition.x) / 0.95;
float tipMix = smoothstep(0.78, 1.05, xNorm);
vec3 tipEmissive = vec3(2.8, 2.9, 3.4);
totalEmissiveRadiance += tipEmissive * tipMix * (1.0 + u_amp * 1.2);`,
      );
    };
    // Six thin tori at varied orientations and slight scales build the core.
    const plasmaGeom = new THREE.TorusGeometry(0.55, 0.05, 20, 220);
    const plasmaA = new THREE.Mesh(plasmaGeom, plasmaMat);
    const plasmaB = new THREE.Mesh(plasmaGeom, plasmaMat);
    const plasmaC = new THREE.Mesh(plasmaGeom, plasmaMat);
    const plasmaD = new THREE.Mesh(plasmaGeom, plasmaMat);
    const plasmaE = new THREE.Mesh(plasmaGeom, plasmaMat);
    const plasmaF = new THREE.Mesh(plasmaGeom, plasmaMat);
    plasmaA.rotation.set(0, 0, 0);
    plasmaB.rotation.set(Math.PI / 3, 0, Math.PI / 4);
    plasmaC.rotation.set(0, Math.PI / 2, Math.PI / 3);
    plasmaD.rotation.set(Math.PI / 5, Math.PI / 4, Math.PI / 6);
    plasmaE.rotation.set(Math.PI / 2, Math.PI / 6, Math.PI / 2);
    plasmaF.rotation.set(Math.PI / 7, Math.PI / 2, Math.PI / 5);
    plasmaB.scale.setScalar(0.92);
    plasmaC.scale.setScalar(0.84);
    plasmaD.scale.setScalar(0.96);
    plasmaE.scale.setScalar(0.78);
    plasmaF.scale.setScalar(0.88);
    // Bending-spacetime stretch. The whole cluster gets squashed vertically and
    // pulled out horizontally so its equator widens toward the outer ribbons.
    // Combined with the bright HDR tips at the new wider X extent, the inner
    // mass appears to fuse with the outer rings at the equator via bloom.
    const innerGroup = new THREE.Group();
    innerGroup.scale.set(1.60, 0.82, 0.82);
    innerGroup.add(plasmaA, plasmaB, plasmaC, plasmaD, plasmaE, plasmaF);
    scene.add(innerGroup);

    // MARK: Postprocessing. Modest bloom so tips spike but body keeps color.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(canvas.clientWidth, canvas.clientHeight),
      0.55, // strength
      0.55, // radius
      0.85, // threshold (only the brightest tip pixels bloom)
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
      ribbon3.rotation.x = Math.PI / 4 + Math.sin(t * 0.10) * 0.45;
      ribbon3.rotation.y = Math.PI / 3 + Math.cos(t * 0.13) * 0.35;
      ribbon3.rotation.z = Math.PI / 6 + Math.sin(t * 0.08) * 0.30;

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
