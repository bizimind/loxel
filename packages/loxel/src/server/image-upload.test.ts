import { describe, expect, test } from "bun:test";

import {
  buildImageFileName,
  detectImageExtension,
  extractRelativeImageRefs,
  formatUploadTimestamp,
  isImageExtension,
  slugifyImageName,
} from "./image-upload";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const ascii = (s: string) => new TextEncoder().encode(s);

describe("detectImageExtension", () => {
  test("recognizes raster formats by magic bytes", () => {
    expect(detectImageExtension(PNG)).toBe("png");
    expect(detectImageExtension(JPG)).toBe("jpg");
    expect(detectImageExtension(ascii("GIF89a....."))).toBe("gif");
    expect(detectImageExtension(ascii("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(detectImageExtension(ascii("\0\0\0 ftypavif...."))).toBe("avif");
    expect(detectImageExtension(ascii("BM......"))).toBe("bmp");
  });

  test("recognizes svg with xml prologue and comments", () => {
    const svg = `﻿<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg>\n<svg xmlns="x"></svg>`;
    expect(detectImageExtension(ascii(svg))).toBe("svg");
    expect(detectImageExtension(ascii("<svg/>"))).toBe("svg");
  });

  test("rejects non-images even when they look like markup", () => {
    expect(detectImageExtension(ascii("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(detectImageExtension(ascii("#!/bin/sh\nrm -rf /"))).toBeNull();
    expect(detectImageExtension(new Uint8Array([]))).toBeNull();
    expect(detectImageExtension(ascii("%PDF-1.4"))).toBeNull();
  });
});

describe("slugifyImageName", () => {
  test("lowercases, strips extension and unsafe characters", () => {
    expect(slugifyImageName("Screenshot 2026-09-22 at 19.21.30.png")).toBe(
      "screenshot-2026-09-22-at-19-21-30",
    );
    expect(slugifyImageName("../../etc/passwd")).toBe("passwd");
    expect(slugifyImageName("Ünïcödé image.JPG")).toBe("unicode-image");
  });

  test("falls back to 'image' and caps length", () => {
    expect(slugifyImageName("")).toBe("image");
    expect(slugifyImageName("...png")).toBe("image");
    expect(slugifyImageName(`${"a".repeat(100)}.png`).length).toBe(40);
    expect(slugifyImageName(`${"ab-".repeat(20)}.png`).endsWith("-")).toBe(false);
  });
});

describe("buildImageFileName", () => {
  test("combines slug, timestamp and detected extension", () => {
    const at = new Date(2026, 8, 22, 19, 21, 30);
    expect(formatUploadTimestamp(at)).toBe("20260922-192130");
    expect(buildImageFileName("My Shot.jpeg", "jpg", at)).toBe("my-shot-20260922-192130.jpg");
  });
});

describe("extractRelativeImageRefs", () => {
  test("collects relative image paths and ignores absolute/remote ones", () => {
    const md = [
      "![a](./one.png)",
      '![b](two.png "title")',
      "![c](<sp%20ace.png>)",
      "![d](https://example.com/x.png)",
      "![e](/abs/x.png)",
      "![f](data:image/png;base64,AAAA)",
      "[link](./not-an-image.png)",
      "![g](./one.png)",
    ].join("\n");
    expect(extractRelativeImageRefs(md)).toEqual(["one.png", "two.png", "sp ace.png"]);
  });

  test("keeps nested relative paths", () => {
    expect(extractRelativeImageRefs("![x](./assets/y.png) ![z](../up.png)")).toEqual([
      "assets/y.png",
      "../up.png",
    ]);
  });
});

describe("isImageExtension", () => {
  test("accepts supported image extensions case-insensitively and rejects others", () => {
    expect(isImageExtension("png")).toBe(true);
    expect(isImageExtension("JPEG")).toBe(true);
    expect(isImageExtension("svg")).toBe(true);
    expect(isImageExtension("md")).toBe(false);
    expect(isImageExtension("txt")).toBe(false);
    expect(isImageExtension("")).toBe(false);
  });
});
