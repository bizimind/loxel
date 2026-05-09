export const MOODS = [
  { mood: "curious", desc: "Exploring unknowns, asking 'what if', investigating mysteries" },
  { mood: "frustrated", desc: "Annoyed by pain points, friction, things that should be easier" },
  { mood: "creative", desc: "Experimental, unconventional, thinking outside the box" },
  { mood: "conservative", desc: "Focused on stability, reliability, reducing risk" },
  { mood: "delighted", desc: "Appreciating what works well, enhancing strengths" },
  { mood: "pragmatic", desc: "Focused on practical value, quick wins, low-hanging fruit" },
  { mood: "ambitious", desc: "Thinking big, long-term impact, transformative changes" },
  { mood: "meticulous", desc: "Focused on details, edge cases, polish and refinement" },
] as const;

export type Mood = (typeof MOODS)[number];

export function selectRandomMood(): Mood {
  return MOODS[Math.floor(Math.random() * MOODS.length)];
}
