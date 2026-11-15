// The site's button looks, shared by the download and GitHub buttons and the links styled like them.

export const BUTTON_BASE =
  "inline-flex items-center gap-2 whitespace-nowrap rounded-md transition-colors";

export const BUTTON_VARIANTS = {
  // Transparent border so a primary button matches an outline one beside it in size.
  primary:
    "border border-transparent bg-primary font-semibold text-primary-foreground hover:bg-accent",
  outline: "border border-border font-medium text-foreground hover:border-muted-foreground",
} as const;

/** `touch` is the larger tap target the phone layouts use, with room for two buttons side by side. */
export const BUTTON_SIZES = {
  md: "px-5 py-2.5 text-sm",
  lg: "px-7 py-3.5 text-base",
  touch: "px-3 py-3 text-sm",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;
export type ButtonSize = keyof typeof BUTTON_SIZES;
