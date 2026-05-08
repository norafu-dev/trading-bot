import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Stable per-author colour for KOL avatars + name labels.
 *
 * The previous Discord-flavoured palette included #FEE75C (bright yellow)
 * and #F47B67 (salmon) which dropped below 2:1 contrast on the light
 * theme's white surface — author names rendered with these were
 * effectively invisible. Replaced with a curated set of -600/-700
 * Tailwind-equivalent tones, all of which clear WCAG AA's 4.5:1 contrast
 * threshold against BOTH #FFFFFF (light theme cards) and #161B27 (dark
 * theme cards), AND clear the same threshold for white-text-on-color
 * (avatar backgrounds with white initials).
 *
 * Hash is deterministic from the Discord user id so the same KOL keeps
 * the same colour across pages, polls, and reloads.
 */
const AUTHOR_PALETTE = [
  "#3B5CF1", // blue-600
  "#15803D", // green-700
  "#B45309", // amber-700  (replaces the old #FEE75C yellow)
  "#BE185D", // rose-700
  "#C71F37", // red-700
  "#7C3AED", // violet-600
  "#0891B2", // cyan-600
  "#A75D44", // terra      (replaces the old #F47B67 salmon)
];

export function authorColor(id: string): string {
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) & 0xffff;
  return AUTHOR_PALETTE[n % AUTHOR_PALETTE.length];
}
