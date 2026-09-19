"use client";

import { useEffect, useRef } from "react";
import { Mesh, Program, Renderer, Triangle } from "ogl";

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;

varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentShader = `
precision highp float;

uniform float uTime;
uniform vec2 uResolution;

varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
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

float threadLine(vec2 p, float lane, float phase, float strength) {
  float drift = sin(p.x * 2.25 + phase + uTime * 0.055) * 0.045;
  drift += sin(p.x * 5.4 - phase * 1.7) * 0.012;
  float distanceToThread = abs(p.y - lane - drift);
  return strength / max(distanceToThread, 0.0015);
}

void main() {
  vec2 uv = vUv;
  vec2 p = uv - 0.5;
  p.x *= uResolution.x / max(uResolution.y, 1.0);

  float haze = noise(p * 2.25 + vec2(uTime * 0.009, 0.0));
  float fineNoise = noise(p * 8.0 - vec2(uTime * 0.014, 0.0));

  vec3 midnight = vec3(0.018, 0.012, 0.035);
  vec3 violet = vec3(0.105, 0.052, 0.17);
  vec3 color = mix(midnight, violet, smoothstep(0.12, 1.0, haze) * 0.42);

  float radial = 1.0 - smoothstep(0.05, 0.9, length(p * vec2(0.72, 1.0)));
  color += vec3(0.075, 0.025, 0.095) * radial;

  float goldThread = threadLine(p, 0.19, 0.0, 0.00042);
  goldThread += threadLine(p, -0.23, 2.7, 0.00027);
  float violetThread = threadLine(p, -0.02, 5.1, 0.00018);

  color += vec3(0.92, 0.52, 0.17) * goldThread;
  color += vec3(0.48, 0.27, 0.92) * violetThread;

  float dust = step(0.992, hash(floor(uv * uResolution.xy * 0.34)));
  color += vec3(0.78, 0.61, 0.36) * dust * (0.05 + fineNoise * 0.09);

  float vignette = smoothstep(0.92, 0.2, length((uv - 0.5) * vec2(1.0, 1.18)));
  color *= mix(0.48, 1.0, vignette);

  gl_FragColor = vec4(color, 1.0);
}
`;

export default function AriadneBackdrop() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = new Renderer({ alpha: false, dpr: Math.min(window.devicePixelRatio, 1.5) });
    const gl = renderer.gl;
    const geometry = new Triangle(gl);
    const program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: new Float32Array([1, 1]) },
      },
    });
    const mesh = new Mesh(gl, { geometry, program });
    let animationFrame = 0;

    const resize = () => {
      renderer.setSize(container.clientWidth, container.clientHeight);
      program.uniforms.uResolution.value[0] = gl.canvas.width;
      program.uniforms.uResolution.value[1] = gl.canvas.height;
    };

    const render = (time: number) => {
      program.uniforms.uTime.value = reduceMotion ? 0 : time * 0.001;
      renderer.render({ scene: mesh });
      if (!reduceMotion) animationFrame = window.requestAnimationFrame(render);
    };

    resize();
    container.appendChild(gl.canvas);
    window.addEventListener("resize", resize);
    render(0);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      gl.canvas.remove();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return <div ref={containerRef} aria-hidden="true" className="absolute inset-0 pointer-events-none" />;
}
