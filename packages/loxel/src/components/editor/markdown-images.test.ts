import { describe, expect, test } from "bun:test";

import { altFromFileName, observeImageLoadErrors, resolveImageSrc } from "./markdown-images";

const md = "/repo/wt/docs/plan.md";
const wt = "/repo/wt";

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
      expect(resolveImageSrc(src, md, wt)).toBe(src);
    }
  });

  test("resolves relative paths inside the worktree to the relative file-raw form", () => {
    expect(resolveImageSrc("./assets/a.png", md, wt)).toBe(
      "/api/file-raw?path=docs%2Fassets%2Fa.png&wt=%2Frepo%2Fwt",
    );
    expect(resolveImageSrc("a.png", md, wt)).toBe(
      "/api/file-raw?path=docs%2Fa.png&wt=%2Frepo%2Fwt",
    );
    expect(resolveImageSrc("../img/a.png", md, wt)).toBe(
      "/api/file-raw?path=img%2Fa.png&wt=%2Frepo%2Fwt",
    );
  });

  test("treats URL-significant characters in the directory path as literal", () => {
    expect(resolveImageSrc("./a.png", "/repo/wt/docs#1/plan.md", wt)).toBe(
      "/api/file-raw?path=docs%231%2Fa.png&wt=%2Frepo%2Fwt",
    );
    expect(resolveImageSrc("./a.png", "/repo/wt/d?x/plan.md", wt)).toBe(
      "/api/file-raw?path=d%3Fx%2Fa.png&wt=%2Frepo%2Fwt",
    );
    expect(resolveImageSrc("./a.png", "/repo/wt/100%/plan.md", wt)).toBe(
      "/api/file-raw?path=100%25%2Fa.png&wt=%2Frepo%2Fwt",
    );
  });

  test("decodes percent-encoded markdown sources", () => {
    expect(resolveImageSrc("./my%20shot.png", md, wt)).toBe(
      "/api/file-raw?path=docs%2Fmy+shot.png&wt=%2Frepo%2Fwt",
    );
  });

  test("uses the absolute form without a worktree hint for drafts and outside paths", () => {
    const draft = "/state/detached/abc/Note 1.md";
    expect(resolveImageSrc("./shot.png", draft, wt)).toBe(
      "/api/file-raw?path=%2Fstate%2Fdetached%2Fabc%2Fshot.png",
    );
    expect(resolveImageSrc("../../outside.png", md, wt)).toBe(
      "/api/file-raw?path=%2Frepo%2Foutside.png",
    );
    expect(resolveImageSrc("/abs/x.png", md, wt)).toBe("/api/file-raw?path=%2Fabs%2Fx.png");
    expect(resolveImageSrc("./a.png", md, null)).toBe(
      "/api/file-raw?path=%2Frepo%2Fwt%2Fdocs%2Fa.png",
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
