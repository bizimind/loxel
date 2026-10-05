// Electron's `-webkit-app-region` (window drag regions) is non-standard, so React's CSS types lack it.
import "react";

declare module "react" {
  interface CSSProperties {
    WebkitAppRegion?: "drag" | "no-drag";
  }
}
