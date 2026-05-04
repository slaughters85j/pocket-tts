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

    // MARK: Glass shell. Transmission gives caustics and edge highlights.
    // No tint, low roughness, slight thickness for refraction depth.
    const shellMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      transmission: 1.0,
      thickness: 0.45,
      roughness: 0.06,
      ior: 1.42,
      transparent: true,
      clearcoat: 1.0,
      clearcoatRoughness: 0.0,
      envMapIntensity: 0.6,
      side: THREE.FrontSide,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1.0, 96, 96), shellMat);
    scene.add(shell);

    // MARK: Inner plasma. Highly metallic purple sphere stretched horizontally.
    // The PBR pipeline gives us env-map reflections, which is what produces the
    // swirly fluid look on a glossy curved surface (no painted noise needed).
    // onBeforeCompile injects two things into the standard PBR shader:
    //   1. Vertex noise displacement so the surface isn't a plain ellipsoid.
    //   2. HDR emissive at the horizontal poles so they bloom into spike artifacts
    //      after passing through the glass shell's refraction.
    const plasmaUniforms = {
      u_time: { value: 0 },
      u_amp: { value: 0 },
    };
    const plasmaMat = new THREE.MeshPhysicalMaterial({
      color: 0x5a1a99,
      metalness: 0.92,
      roughness: 0.18,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      iridescence: 0.7,
      iridescenceIOR: 1.35,
      iridescenceThicknessRange: [200, 700],
      envMapIntensity: 1.6,
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
varying vec3 vObjectPos;`,
      ).replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vObjectPos = position;
float n_a = snoise(position * 1.6 + vec3(u_time * 0.20));
float n_b = snoise(position * 3.1 - vec3(u_time * 0.13)) * 0.5;
transformed += normal * (n_a + n_b) * (0.04 + u_amp * 0.10);`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
uniform float u_amp;
varying vec3 vObjectPos;`,
      ).replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
float xNorm = abs(vObjectPos.x) / 0.55;
float tipMix = smoothstep(0.82, 1.00, xNorm);
vec3 tipEmissive = vec3(2.5, 2.7, 3.2);
totalEmissiveRadiance += tipEmissive * tipMix * (1.0 + u_amp * 1.2);`,
      );
    };
    const plasma = new THREE.Mesh(new THREE.SphereGeometry(0.55, 96, 96), plasmaMat);
    plasma.scale.set(1.55, 0.95, 0.95);
    scene.add(plasma);

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

    // MARK: Animation loop
    const start = performance.now();
    const fftBins = 64;
    const dataArray = new Uint8Array(fftBins);
    let smoothAmp = 0;
    let smoothActive = 0;
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
      smoothAmp    += (rawAmp - smoothAmp) * 0.20;
      smoothActive += ((isActiveRef.current ? 1 : 0) - smoothActive) * 0.05;

      // Plasma uniforms drive the shader animation.
      plasmaUniforms.u_time.value = t;
      plasmaUniforms.u_amp.value = smoothAmp;

      // Slow tumble so the bright tips drift around the equator subtly.
      // Audio activity speeds it up.
      const rotSpeed = 0.5 + smoothActive * 0.6 + smoothAmp * 1.2;
      plasma.rotation.y = t * 0.10 * rotSpeed;
      plasma.rotation.z = Math.sin(t * 0.18) * 0.10;
      plasma.rotation.x = Math.cos(t * 0.22) * 0.06;

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
      envTexture.dispose();
      pmrem.dispose();
      composer.dispose();
      renderer.dispose();
    };
  }, [playerRef]);

  return <canvas ref={canvasRef} className="w-full h-full block" style={{ display: 'block' }} />;
}
