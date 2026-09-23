import { describe, expect, test } from "bun:test";

import { altFromFileName, observeImageLoadErrors, resolveImageSrc } from "./markdown-images";

const md = "/repo/wt/docs/plan.md";

describe("resolveImageSrc", () => {
  test("passes absolute, data, blob and protocol-relative URLs through", () => {
    for (const src of [
      "https://example.com/a.png",
      "http://x/a.png",
      "data:image/png;base64,AAAA",
      "blob:http://localhost/abc",
      "//cdn.example.com/a.png",
      "",
    ]) {
      expect(resolveImageSrc(src, md)).toBe(src);
    }
  });

  test("resolves relative paths against the markdown file's directory", () => {
    expect(resolveImageSrc("./assets/a.png", md)).toBe(
      "/api/file-raw?path=%2Frepo%2Fwt%2Fdocs%2Fassets%2Fa.png",
    );
    expect(resolveImageSrc("a.png", md)).toBe("/api/file-raw?path=%2Frepo%2Fwt%2Fdocs%2Fa.png");
    expect(resolveImageSrc("../img/a.png", md)).toBe(
      "/api/file-raw?path=%2Frepo%2Fwt%2Fimg%2Fa.png",
    );
    expect(resolveImageSrc("/abs/x.png", md)).toBe("/api/file-raw?path=%2Fabs%2Fx.png");
  });

  test("treats URL-significant characters in the directory path as literal", () => {
    expect(resolveImageSrc("./a.png", "/repo/wt/docs#1/plan.md")).toBe(
      "/api/file-raw?path=%2Frepo%2Fwt%2Fdocs%231%2Fa.png",
    );
    expect(resolveImageSrc("./a.png", "/repo/wt/d?x/plan.md")).toBe(
      "/api/file-raw?path=%2Frepo%2Fwt%2Fd%3Fx%2Fa.png",
    );
    expect(resolveImageSrc("./a.png", "/repo/wt/100%/plan.md")).toBe(
      "/api/file-raw?path=%2Frepo%2Fwt%2F100%25%2Fa.png",
    );
  });

  test("decodes percent-encoded markdown sources", () => {
    expect(resolveImageSrc("./my%20shot.png", md)).toBe(
      "/api/file-raw?path=%2Frepo%2Fwt%2Fdocs%2Fmy+shot.png",
    );
  });

  test("never sends a worktree hint, so drafts resolve by ownership only", () => {
    expect(resolveImageSrc("./shot.png", "/state/detached/abc/Note 1.md")).toBe(
      "/api/file-raw?path=%2Fstate%2Fdetached%2Fabc%2Fshot.png",
    );
  });
});

describe("altFromFileName", () => {
  test("strips the extension and falls back to 'image'", () => {
    expect(altFromFileName("Screenshot.png")).toBe("Screenshot");
    expect(altFromFileName("a.b.png")).toBe("a.b");
    expect(altFromFileName(".png")).toBe("image");
  });
});

describe("observeImageLoadErrors", () => {
  test("toggles the broken class on the node-view wrapper", () => {
    const root = document.createElement("div");
    root.innerHTML = `<span class="milkdown-image-inline"><img class="image-inline"></span>`;
    const img = root.querySelector("img")!;
    const wrapper = root.querySelector(".milkdown-image-inline")!;
    const stop = observeImageLoadErrors(root);

    img.dispatchEvent(new Event("error"));
    expect(wrapper.classList.contains("broken")).toBe(true);
    img.dispatchEvent(new Event("load"));
    expect(wrapper.classList.contains("broken")).toBe(false);

    stop();
    img.dispatchEvent(new Event("error"));
    expect(wrapper.classList.contains("broken")).toBe(false);
  });
});
