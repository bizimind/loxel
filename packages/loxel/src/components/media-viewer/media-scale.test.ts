import { describe, expect, test } from "bun:test";

import { actualSizeScale, clampZoom, fitWithin, zoomPercent } from "./media-scale";

const PANEL = { width: 1300, height: 880 };

describe("media smaller than the panel", () => {
  const media = { width: 480, height: 320, scalesToFit: false };

  test("is drawn at its natural size at scale 1", () => {
    expect(fitWithin(media, PANEL)).toEqual({ width: 480, height: 320 });
  });

  test("needs no zoom for actual size", () => {
    expect(actualSizeScale(media, PANEL)).toBe(1);
  });

  test("reads 100% at scale 1 and follows the scale", () => {
    expect(zoomPercent(1, media, PANEL)).toBe(100);
    expect(zoomPercent(2, media, PANEL)).toBe(200);
  });
});

describe("media larger than the panel", () => {
  // Width-bound: 2600 wide in a 1300 panel is drawn at half size.
  const media = { width: 2600, height: 1000, scalesToFit: false };

  test("is shrunk to fit at scale 1, keeping its aspect ratio", () => {
    expect(fitWithin(media, PANEL)).toEqual({ width: 1300, height: 500 });
  });

  test("zooms back up for actual size", () => {
    expect(actualSizeScale(media, PANEL)).toBe(2);
  });

  test("reads its fitted size at scale 1 and 100% at actual size", () => {
    expect(zoomPercent(1, media, PANEL)).toBe(50);
    expect(zoomPercent(2, media, PANEL)).toBe(100);
  });

  test("is bound by whichever side overflows more", () => {
    const tall = { width: 1000, height: 1760, scalesToFit: false };
    expect(fitWithin(tall, PANEL)).toEqual({ width: 500, height: 880 });
    expect(actualSizeScale(tall, PANEL)).toBe(2);
  });
});

describe("media the frame scales to fit", () => {
  test("is enlarged to fit when smaller than the panel, and zooms down for actual size", () => {
    // Height-bound: 220 tall in an 880 panel is drawn 4x.
    const media = { width: 300, height: 220, scalesToFit: true };
    expect(fitWithin(media, PANEL)).toEqual({ width: 1200, height: 880 });
    expect(actualSizeScale(media, PANEL)).toBe(0.25);
    expect(zoomPercent(1, media, PANEL)).toBe(400);
    expect(zoomPercent(0.25, media, PANEL)).toBe(100);
  });

  test("is shrunk to fit when larger than the panel", () => {
    const media = { width: 2600, height: 1000, scalesToFit: true };
    expect(fitWithin(media, PANEL)).toEqual({ width: 1300, height: 500 });
    expect(actualSizeScale(media, PANEL)).toBe(2);
  });
});

describe("degenerate sizes fall back to scale 1", () => {
  test("an unmeasured panel", () => {
    const empty = { width: 0, height: 0 };
    expect(actualSizeScale({ width: 480, height: 320, scalesToFit: true }, empty)).toBe(1);
    expect(actualSizeScale({ width: 480, height: 320, scalesToFit: false }, empty)).toBe(1);
  });

  test("zero-sized media", () => {
    const media = { width: 0, height: 0, scalesToFit: true };
    expect(actualSizeScale(media, PANEL)).toBe(1);
    expect(zoomPercent(1, media, PANEL)).toBe(100);
  });
});

describe("clampZoom", () => {
  test("keeps steps within the zoom limits", () => {
    expect(clampZoom(1, 1.2)).toBe(1.2);
    expect(clampZoom(0.06, 0.01)).toBe(0.05);
    expect(clampZoom(40, 60)).toBe(50);
  });

  test("never steps the wrong way from a scale outside the limits", () => {
    // Actual size of a 24px icon enlarged to fill an 880px panel.
    const tiny = 24 / 880;
    expect(clampZoom(tiny, tiny / 1.2)).toBe(tiny);
    expect(clampZoom(tiny, tiny * 1.2)).toBe(tiny * 1.2);
    expect(clampZoom(80, 96)).toBe(80);
    expect(clampZoom(80, 80 / 1.2)).toBe(80 / 1.2);
  });
});
