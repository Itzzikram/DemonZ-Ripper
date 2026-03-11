/**
 * Math utilities.
 */

const SESSION_SEED = Math.random().toString(36).slice(2, 8);
let idCounter = 0;
export function generateId(prefix = 'id'): string {
  return `${prefix}_${SESSION_SEED}${++idCounter}_${Date.now().toString(36)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function degToRad(degrees: number): number {
  return degrees * (Math.PI / 180);
}

export function radToDeg(radians: number): number {
  return radians * (180 / Math.PI);
}
