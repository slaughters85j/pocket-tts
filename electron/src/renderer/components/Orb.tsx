import React, { useEffect, useRef } from 'react';
import type { StreamingWavPlayer } from '../lib/streaming-wav-player';

// MARK: - Shaders

const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// "Glass orb with internal fluid" — defined dark sphere with violet/purple swirling
// fluid inside, fresnel rim, anisotropic latitude bands wrapping around, and bright
// specular hotspots on the left/right equator. Stable & slow, not erratic.
const FRAGMENT_SHADER = `
precision highp float;
uniform float u_time;
uniform float u_energy;   // 0..1 instantaneous audio level
uniform float u_active;   // 0..1 LLM/TTS active flag (smoothed)
uniform vec2  u_resolution;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

// Thin highlight arc — band on the sphere where dot(N, L) sits at value c.
// Projected to 2D, this reads as a curved highlight (specular reflection of a
// distant light off the glass surface).
float arcBand(vec3 N, vec3 L, float c, float w) {
  float d = abs(dot(normalize(L), N) - c);
  return smoothstep(w, w * 0.25, d);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  float R  = 0.40;            // sphere radius
  float R2 = R * R;
  float r  = length(uv);
  float r2 = dot(uv, uv);

  // Sphere depth (z² = R² - r²) — unit normal of the implicit sphere at this pixel.
  float z2 = max(R2 - r2, 0.0);
  float z  = sqrt(z2);
  vec3  N  = vec3(uv.x, uv.y, z) / R;

  // Smooth sphere mask + outer halo so the boundary anti-aliases cleanly.
  float sphereMask = smoothstep(R2 + 0.006, R2 - 0.006, r2);
  float outerHalo  = exp(-(r - R) * 9.0) * (1.0 - sphereMask);

  // Thin fresnel rim — high power keeps the silhouette as a crisp glass edge.
  float fres = pow(1.0 - max(N.z, 0.0), 6.0);

  // Curved highlight arcs — specular reflections of fake key/rim lights, each
  // appears as a curve on the sphere where dot(N, L) sits at a fixed angle.
  float arcTop = arcBand(N, vec3( 0.00,  0.85, 0.55), 0.62, 0.040);
  float arcBtm = arcBand(N, vec3( 0.00, -0.85, 0.55), 0.65, 0.050);
  float arcL   = arcBand(N, vec3(-0.85,  0.10, 0.45), 0.55, 0.030);
  float arcR   = arcBand(N, vec3( 0.85,  0.10, 0.45), 0.55, 0.030);
  float arcUp  = arcBand(N, vec3( 0.00,  0.65, 0.75), 0.40, 0.030);  // softer upper band
  float arcs   = arcTop + arcBtm + arcL + arcR + arcUp;

  // Internal fluid — slow, viscous, domain-warped swirl.
  float fluidSpeed = 1.0 + u_energy * 0.6 + u_active * 0.15;
  vec2  fluidUv    = uv * 1.8;
  vec2  fluidWarp  = vec2(
    fbm(fluidUv * 0.75 + vec2(u_time * 0.05 * fluidSpeed, 0.0)),
    fbm(fluidUv * 0.75 + vec2(0.0, u_time * 0.06 * fluidSpeed) + 5.0)
  ) - 0.5;
  fluidUv += fluidWarp * 0.45;
  float swirl1 = fbm(fluidUv + vec2(u_time * 0.10 * fluidSpeed, u_time * 0.055 * fluidSpeed));
  float swirl2 = fbm(fluidUv * 1.5 - vec2(u_time * 0.065 * fluidSpeed, u_time * 0.09 * fluidSpeed) + 9.0);
  float swirl  = swirl1 * 0.55 + swirl2 * 0.45;

  // Internal palette — deep violet base, bright violet body, white-purple specular peaks.
  vec3 deepViolet   = vec3(0.06, 0.02, 0.18);
  vec3 brightViolet = vec3(0.55, 0.18, 0.85);
  vec3 specPeak     = vec3(0.95, 0.85, 1.00);

  vec3 fluidCol = mix(deepViolet, brightViolet, smoothstep(0.40, 0.78, swirl));
  fluidCol += specPeak * pow(max(swirl - 0.70, 0.0), 4.0) * 1.8;

  // Concentrate the swirl as a "blob in the middle" rather than filling the whole
  // sphere — Gaussian falloff toward the silhouette so the outer shell reads as
  // clear glass with just the rim and arc highlights.
  float blobMask = exp(-r2 * 6.0);

  // --- Composite ---
  vec3 col = vec3(0.0);

  // Internal fluid blob (concentrated near center, behind the glass shell)
  col += fluidCol * blobMask * sphereMask;

  // Thin fresnel rim — pale blue-white edge of the glass shell
  col += vec3(0.65, 0.75, 1.00) * fres * 0.95 * sphereMask;

  // Curved highlight arcs — bright white-blue specular reflections on the shell
  col += vec3(0.95, 0.97, 1.00) * arcs * 0.85 * sphereMask;

  // Outer halo
  col += vec3(0.20, 0.25, 0.55) * outerHalo * 0.30;

  // Audio reactivity
  col *= 1.0 + u_energy * 0.30;

  col = col / (1.0 + col * 0.40);

  gl_FragColor = vec4(col, 1.0);
}
`;

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

    const gl = canvas.getContext('webgl');
    if (!gl) {
      console.error('[Orb] WebGL not available');
      return;
    }

    // MARK: Compile shaders
    const compile = (type: number, src: string): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('[Orb] Shader error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[Orb] Program link error:', gl.getProgramInfoLog(program));
      return;
    }

    // MARK: Fullscreen quad
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // prettier-ignore
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(program, 'a_position');
    const uTime = gl.getUniformLocation(program, 'u_time');
    const uEnergy = gl.getUniformLocation(program, 'u_energy');
    const uActive = gl.getUniformLocation(program, 'u_active');
    const uRes = gl.getUniformLocation(program, 'u_resolution');

    gl.useProgram(program);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // MARK: Resize
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // MARK: Animation loop
    const start = performance.now();
    const fftBins = 64;
    const dataArray = new Uint8Array(fftBins);
    let smoothEnergy = 0;
    let smoothActive = 0;
    let raf = 0;

    const tick = () => {
      const t = (performance.now() - start) / 1000;

      // Read instantaneous audio energy
      let rawEnergy = 0;
      const player = playerRef.current;
      if (player && !player.isStopped) {
        const analyser = player.getAnalyser();
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < fftBins; i++) sum += dataArray[i];
        rawEnergy = sum / (fftBins * 255);
      }

      smoothEnergy += (rawEnergy - smoothEnergy) * 0.20;
      smoothActive += ((isActiveRef.current ? 1 : 0) - smoothActive) * 0.05;

      gl.uniform1f(uTime, t);
      gl.uniform1f(uEnergy, smoothEnergy);
      gl.uniform1f(uActive, smoothActive);
      gl.uniform2f(uRes, canvas.width, canvas.height);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buffer);
    };
  }, [playerRef]);

  return <canvas ref={canvasRef} className="w-full h-full block" style={{ display: 'block' }} />;
}
