import { PUBLIC_POSTHOG_KEY } from "astro:env/client";
import type { CaptureOptions } from "posthog-js";

// The custom events the site sends, with their properties. Markup opts in through the
// `trackClick`/`trackView`/`trackScrollDepth` attribute helpers below, so tracking never depends on
// copy or CSS selectors.
interface ClickEvents {
  download_clicked: { platform: string; arch: string; version: string; location: string };
  github_link_clicked: { location: string };
  docs_nav_clicked: { from: string; to: string };
}

interface ViewEvents {
  cta_viewed: { location: string };
}

interface ScrollDepthEvents {
  docs_scroll_depth: { slug: string };
}

const SCROLL_DEPTH_MILESTONES = [25, 50, 75, 100];

/** Captures `event` when the element (or anything inside it) is clicked. */
export function trackClick<E extends keyof ClickEvents>(event: E, props: ClickEvents[E]) {
  return { "data-analytics-click": event, "data-analytics-props": JSON.stringify(props) };
}

/** Captures `event` once per page load, when half of the element is in the viewport. */
export function trackView<E extends keyof ViewEvents>(event: E, props: ViewEvents[E]) {
  return { "data-analytics-view": event, "data-analytics-props": JSON.stringify(props) };
}

/** Captures `event` with a `depth` property as the reader scrolls past 25/50/75/100% of the element. */
export function trackScrollDepth<E extends keyof ScrollDepthEvents>(
  event: E,
  props: ScrollDepthEvents[E],
) {
  return { "data-analytics-scroll-depth": event, "data-analytics-props": JSON.stringify(props) };
}

type Capture = (event: string, props: Record<string, unknown>, options?: CaptureOptions) => void;

/**
 * Loads PostHog and wires the `data-analytics-*` attributes to it. Does nothing in `astro dev` or
 * when the build has no `PUBLIC_POSTHOG_KEY`, so local and preview builds send nothing.
 */
export function initAnalytics(): void {
  const key = PUBLIC_POSTHOG_KEY;
  if (import.meta.env.DEV || !key) return;

  // Starts loading right away (asynchronously, without blocking rendering): events captured
  // before the SDK is ready are lost if the visitor leaves the page in the meantime.
  const posthog = loadPostHog(key).catch(() => undefined);
  const capture: Capture = (event, props, options) => {
    void posthog.then((client) => client?.capture(event, props, options));
  };

  trackClicks(capture);
  trackViews(capture);
  trackScrollDepths(capture);
}

async function loadPostHog(key: string) {
  const { default: posthog } = await import("posthog-js");
  posthog.init(key, {
    // Proxied through the site's own domain (functions/ingest) so ad blockers don't drop events.
    api_host: "/ingest",
    ui_host: "https://eu.posthog.com",
    defaults: "2026-08-30",
    // No cookies or storage, so no consent banner: PostHog derives the visitor from a daily-salted
    // hash of IP and user agent. Requires cookieless tracking to be enabled in the project settings.
    cookieless_mode: "always",
    // Only analytics is used, so skip the lazily loaded replay, surveys, and toolbar scripts.
    disable_external_dependency_loading: true,
  });
  return posthog;
}

function readProps(element: HTMLElement): Record<string, unknown> {
  const parsed: unknown = JSON.parse(element.dataset.analyticsProps ?? "{}");
  return typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
}

function trackClicks(capture: Capture): void {
  const onClick = (event: MouseEvent) => {
    // auxclick also fires for right clicks, which open a menu rather than the link.
    if (event.type === "auxclick" && event.button !== 1) return;
    if (!(event.target instanceof Element)) return;
    const element = event.target.closest<HTMLElement>("[data-analytics-click]");
    const name = element?.dataset.analyticsClick;
    if (!element || !name) return;
    // Tracked clicks often leave the page, which drops events still waiting in PostHog's batch queue.
    capture(name, readProps(element), { send_instantly: true, transport: "sendBeacon" });
  };
  document.addEventListener("click", onClick, { capture: true });
  document.addEventListener("auxclick", onClick, { capture: true });
}

function trackViews(capture: Capture): void {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
        observer.unobserve(entry.target);
        const name = entry.target.dataset.analyticsView;
        if (name) capture(name, readProps(entry.target));
      }
    },
    { threshold: 0.5 },
  );
  for (const element of document.querySelectorAll("[data-analytics-view]")) {
    observer.observe(element);
  }
}

function trackScrollDepths(capture: Capture): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-analytics-scroll-depth]")) {
    const name = element.dataset.analyticsScrollDepth;
    if (!name) continue;
    const props = readProps(element);
    const pending = [...SCROLL_DEPTH_MILESTONES];
    // Counts only what the reader scrolls to, so a page that fits on screen isn't reported as read.
    const check = () => {
      const { top, height } = element.getBoundingClientRect();
      const seen = height > 0 ? ((window.innerHeight - top) / height) * 100 : 0;
      while (pending.length > 0 && seen >= pending[0]) {
        capture(name, { ...props, depth: pending.shift() });
      }
      if (pending.length === 0) window.removeEventListener("scroll", check);
    };
    window.addEventListener("scroll", check, { passive: true });
  }
}
