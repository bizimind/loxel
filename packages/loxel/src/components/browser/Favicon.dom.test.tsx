import { afterEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, render } from "@testing-library/react";

import { stubElectronAPI } from "@/test/electron-api-stub";

import { Favicon } from "./Favicon";

/** A `loadFavicon` whose loads the test settles, by URL. */
function controlledLoads() {
  const settle = new Map<string, ((src: string | null) => void)[]>();
  const loadFavicon = mock(
    (url: string, _pageUrl?: string) =>
      new Promise<string | null>((resolve) => {
        settle.set(url, [...(settle.get(url) ?? []), resolve]);
      }),
  );
  window.electronAPI = stubElectronAPI({ loadFavicon });
  const resolve = (url: string, src: string | null) =>
    act(async () => {
      for (const settleLoad of settle.get(url) ?? []) settleLoad(src);
      settle.delete(url);
      // Run every promise callback queued meanwhile: the load, then the elements showing it.
      await new Promise((flushed) => {
        setTimeout(flushed);
      });
    });
  return { loadFavicon, resolve };
}

const src = (container: HTMLElement) => container.querySelector("img")?.getAttribute("src");
const isGlobe = (container: HTMLElement) =>
  container.querySelector("svg.lucide-globe") !== null && !container.querySelector("img");

afterEach(() => {
  cleanup();
  window.electronAPI = undefined;
});

describe("Favicon in the desktop app", () => {
  test("loads a web favicon through main, once for every element showing it", async () => {
    const { loadFavicon, resolve } = controlledLoads();
    const url = "https://a.example/favicon.ico";
    const first = render(<Favicon url={url} />);
    expect(isGlobe(first.container)).toBe(true);
    await resolve(url, "data:image/x-icon;base64,AA");
    expect(src(first.container)).toBe("data:image/x-icon;base64,AA");

    // A tab rebuilt by a worktree switch shows it at once.
    const second = render(<Favicon url={url} />);
    expect(src(second.container)).toBe("data:image/x-icon;base64,AA");
    expect(loadFavicon).toHaveBeenCalledTimes(1);
  });

  test("keeps the favicon before while a page's new one loads, and drops it with the page", async () => {
    const { resolve } = controlledLoads();
    const view = render(<Favicon url="https://b.example/1.png" />);
    await resolve("https://b.example/1.png", "data:image/png;base64,MQ==");

    view.rerender(<Favicon url="https://b.example/2.png" />);
    expect(src(view.container)).toBe("data:image/png;base64,MQ==");
    await resolve("https://b.example/2.png", "data:image/png;base64,Mg==");
    expect(src(view.container)).toBe("data:image/png;base64,Mg==");

    view.rerender(<Favicon url={undefined} />);
    view.rerender(<Favicon url="https://b.example/3.png" />);
    expect(isGlobe(view.container)).toBe(true);
    // Loads are the window's: none is left running for the next test.
    await resolve("https://b.example/3.png", null);
  });

  test("shows a globe for a favicon that fails to load, and tries it again later", async () => {
    const { loadFavicon, resolve } = controlledLoads();
    const url = "https://c.example/favicon.ico";
    const view = render(<Favicon url={url} />);
    await resolve(url, null);
    expect(isGlobe(view.container)).toBe(true);

    view.unmount();
    render(<Favicon url={url} />);
    expect(loadFavicon).toHaveBeenCalledTimes(2);
    await resolve(url, null);
  });

  test("asks for the site's cookies only for a favicon of the page's own origin", async () => {
    const { loadFavicon, resolve } = controlledLoads();
    const url = "https://e.example/favicon.ico";
    render(<Favicon url={url} pageUrl="https://e.example/inbox" />);
    render(<Favicon url={url} pageUrl="https://other.example/" />);
    expect(loadFavicon.mock.calls).toEqual([
      [url, "https://e.example/inbox"],
      [url, undefined],
    ]);
    await resolve(url, null);
  });

  test("runs a few loads at once, and drops queued ones that are no longer shown", async () => {
    const { loadFavicon, resolve } = controlledLoads();
    const urls = Array.from({ length: 8 }, (_, i) => `https://f.example/${i}.png`);
    const views = urls.map((url) => render(<Favicon url={url} />));
    expect(loadFavicon).toHaveBeenCalledTimes(6);

    // A page cycling through favicons: the eighth is gone before its turn.
    views[7]?.unmount();
    await resolve(urls[0]!, null);
    await resolve(urls[1]!, null);
    expect(loadFavicon.mock.calls.map(([url]) => url)).toEqual(urls.slice(0, 7));
    for (const url of urls.slice(2, 7)) await resolve(url, null);
  });

  test("shows an inline favicon as it is", () => {
    const { loadFavicon } = controlledLoads();
    const { container } = render(<Favicon url="data:image/png;base64,AA" />);
    expect(src(container)).toBe("data:image/png;base64,AA");
    expect(loadFavicon).not.toHaveBeenCalled();
  });
});

test("outside the desktop app the window loads the favicon itself", () => {
  const { container } = render(<Favicon url="https://d.example/favicon.ico" />);
  expect(src(container)).toBe("https://d.example/favicon.ico");
});
