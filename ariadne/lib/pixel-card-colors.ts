/** Lighten (positive) or darken (negative) a `#rrggbb` colour by `percent` of 255. */
function shade(hex: string, percent: number): string {
  const num = parseInt(hex.replace("#", ""), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const r = clamp(((num >> 16) & 0xff) + Math.round(255 * percent));
  const g = clamp(((num >> 8) & 0xff) + Math.round(255 * percent));
  const b = clamp((num & 0xff) + Math.round(255 * percent));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Three-stop pixel palette (light, base, dark) so a PixelCard's hover effect reads as one colour. */
export function pixelPalette(hex: string): string {
  return [shade(hex, 0.45), hex, shade(hex, -0.3)].join(",");
}
