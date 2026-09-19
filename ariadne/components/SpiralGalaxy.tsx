"use client";

import { useEffect, useRef } from "react";

const TAU = Math.PI * 2;

// Fixed, independently varied values keep the composition stable between page loads.
const TEXTURE_SIZE = 1661;
const PARTICLE_COUNT = 13_247;
const ARM_COUNT = 5;
const ARM_TWIST = 6.18;
const VERTICAL_COMPRESSION = 0.438;
const DISPLAY_SCALE = 1.372;
const FLOW_RATE = 0.0619;
const INITIAL_ROTATION = -0.047;
const LAYER_OPACITY = 0.944;

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function mix(start: number, end: number, amount: number) {
  return Math.round(start + (end - start) * amount);
}

function particleColor(distance: number, variation: number) {
  const warm = [255, 181, 109] as const;
  const rose = [225, 121, 211] as const;
  const violet = [126, 143, 255] as const;
  const source = distance < 0.46 ? warm : rose;
  const target = distance < 0.46 ? rose : violet;
  const amount = distance < 0.46 ? distance / 0.46 : (distance - 0.46) / 0.54;

  return source.map((channel, index) =>
    Math.max(0, Math.min(255, mix(channel, target[index], amount) + variation))
  );
}

function createGalaxyTexture() {
  const texture = document.createElement("canvas");
  texture.width = TEXTURE_SIZE;
  texture.height = TEXTURE_SIZE;

  const context = texture.getContext("2d");
  if (!context) return texture;

  const random = seededRandom(0xa71ad9e);
  const center = TEXTURE_SIZE / 2;
  const radius = TEXTURE_SIZE * 0.474;

  context.save();
  context.translate(center, center);
  context.scale(1, VERTICAL_COMPRESSION);
  const halo = context.createRadialGradient(0, 0, 0, 0, 0, radius);
  halo.addColorStop(0, "rgba(255, 210, 133, 0.72)");
  halo.addColorStop(0.075, "rgba(255, 161, 117, 0.34)");
  halo.addColorStop(0.28, "rgba(214, 101, 206, 0.15)");
  halo.addColorStop(0.68, "rgba(103, 87, 204, 0.055)");
  halo.addColorStop(1, "rgba(45, 39, 112, 0)");
  context.fillStyle = halo;
  context.beginPath();
  context.arc(0, 0, radius, 0, TAU);
  context.fill();
  context.restore();

  for (let index = 0; index < PARTICLE_COUNT; index += 1) {
    const distance = Math.pow(random(), 0.61);
    const radialDistance = distance * radius;
    const isDiffuseDust = random() < 0.237;
    const arm = index % ARM_COUNT;
    const armAngle = (arm / ARM_COUNT) * TAU;
    const scatter = (random() - 0.5) * (0.22 + distance * 0.84);
    const angle = isDiffuseDust
      ? random() * TAU
      : armAngle + distance * ARM_TWIST + scatter;
    const radialNoise = (random() - 0.5) * radius * (isDiffuseDust ? 0.086 : 0.032);
    const x = center + Math.cos(angle) * (radialDistance + radialNoise);
    const y =
      center +
      Math.sin(angle) * (radialDistance + radialNoise) * VERTICAL_COMPRESSION +
      (random() - 0.5) * radius * (0.014 + distance * 0.047);
    const variation = Math.round((random() - 0.5) * 34);
    const [red, green, blue] = particleColor(distance, variation);
    const edgeFade = Math.pow(1 - distance, 0.43);
    const alpha =
      (isDiffuseDust ? 0.105 : 0.24 + random() * 0.54) *
      (0.31 + edgeFade * 0.69);
    const size =
      (isDiffuseDust ? 0.48 : 0.62 + random() * 1.36) *
      (1.13 - distance * 0.29);

    context.fillStyle = `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    context.fillRect(x, y, size, size);
  }

  const brightStars = 123;
  for (let index = 0; index < brightStars; index += 1) {
    const distance = Math.pow(random(), 0.74);
    const arm = index % ARM_COUNT;
    const angle =
      (arm / ARM_COUNT) * TAU +
      distance * ARM_TWIST +
      (random() - 0.5) * (0.16 + distance * 0.39);
    const x = center + Math.cos(angle) * distance * radius;
    const y = center + Math.sin(angle) * distance * radius * VERTICAL_COMPRESSION;
    const starRadius = 1.6 + random() * 4.8;
    const flare = context.createRadialGradient(x, y, 0, x, y, starRadius);
    flare.addColorStop(0, "rgba(255, 250, 232, 0.96)");
    flare.addColorStop(0.18, "rgba(255, 199, 236, 0.72)");
    flare.addColorStop(1, "rgba(157, 127, 255, 0)");
    context.fillStyle = flare;
    context.beginPath();
    context.arc(x, y, starRadius, 0, TAU);
    context.fill();
  }

  const core = context.createRadialGradient(center, center, 0, center, center, radius * 0.19);
  core.addColorStop(0, "rgba(255, 243, 164, 0.91)");
  core.addColorStop(0.055, "rgba(255, 195, 104, 0.68)");
  core.addColorStop(0.31, "rgba(240, 130, 184, 0.24)");
  core.addColorStop(1, "rgba(183, 85, 225, 0)");
  context.save();
  context.translate(center, center);
  context.scale(1, 0.62);
  context.translate(-center, -center);
  context.fillStyle = core;
  context.beginPath();
  context.arc(center, center, radius * 0.19, 0, TAU);
  context.fill();
  context.restore();

  return texture;
}

export default function SpiralGalaxy({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    const texture = createGalaxyTexture();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let animationFrame = 0;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
    };

    const render = (time: number) => {
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.save();
      context.globalCompositeOperation = "screen";
      context.globalAlpha = LAYER_OPACITY;
      context.translate(width * 0.5, height * 0.635);
      context.rotate(INITIAL_ROTATION + (reducedMotion ? 0 : (time / 1000) * FLOW_RATE));

      const diameter = Math.max(width, height) * DISPLAY_SCALE;
      context.drawImage(texture, -diameter / 2, -diameter / 2, diameter, diameter);
      context.restore();

      if (!reducedMotion) animationFrame = window.requestAnimationFrame(render);
    };

    const handleResize = () => {
      resize();
      if (reducedMotion) render(0);
    };

    resize();
    render(0);
    window.addEventListener("resize", handleResize);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
