export const PRINCIPLES = [
  "DRY — Single Source of Truth: One definition, derive everything else. Don't maintain parallel structures that drift.",
  "KISS — Keep It Simple: Simplest solution that solves the problem. Resist adding complexity for hypothetical future needs.",
  "Compose Simple Parts: Build complex behavior by stacking small, focused, independently testable layers.",
  "Explicit Over Implicit: Declare intent directly. Don't rely on convention, inference, or magic.",
  "Ownership — Ship Complete Packages: A package isn't done until it's fully owned: README, CI, tests, lint, types, and thought given to how others will use it.",
  "Reliable & Stable: Design for things to stay working. Think about failure modes, edge cases, and what could break.",
  "Performance-Aware, Not Premature: Performance matters where it matters. Choose fast tools and designs for hot paths, but don't optimize what isn't a bottleneck.",
  "Fail Informatively: When things go wrong, provide enough context to understand and recover. Errors are data, not just messages.",
  "Design for Your User: Understand who/what will use the system and design around their constraints and needs.",
  "Automate the Tedious: If something is repetitive and error-prone, automate it. Automation should be self-maintaining where possible.",
];

export function selectRandomPrinciples(count: number = 4): string[] {
  const shuffled = [...PRINCIPLES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, PRINCIPLES.length));
}
