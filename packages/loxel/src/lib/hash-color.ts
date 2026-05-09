/** DJB2-style hash — converts a string to a 64-bit BigInt. Same algorithm as SessionAvatar. */
export function hashStringToBigInt(str: string): bigint {
  let hash = 0n;
  for (let i = 0; i < str.length; i++) {
    const char = BigInt(str.charCodeAt(i));
    hash = (hash << 5n) - hash + char;
    hash = hash & 0xffffffffffffffffn; // Keep within 64 bits
  }
  return hash;
}

/**
 * Derive an OkLCH background color and contrasting text color from an ID.
 *
 * Uses OkLCH for perceptually uniform results:
 * - Lightness fixed at 0.55 — vibrant but not blinding
 * - Chroma fixed at 0.14 — clearly colored, never gray
 * - Hue derived from hash — full 360° color wheel
 * - Text color chosen by lightness threshold for guaranteed contrast
 */
export function idToColor(id: string): { bg: string; text: string } {
  const hash = hashStringToBigInt(id);
  const hue = Number(hash % 360n);
  const lightness = 0.55;
  const chroma = 0.14;

  return {
    bg: `oklch(${lightness} ${chroma} ${hue})`,
    text: lightness > 0.6 ? "oklch(0.2 0 0)" : "white",
  };
}
