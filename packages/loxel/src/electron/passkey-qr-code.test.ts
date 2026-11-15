import { describe, expect, test } from "bun:test";

import { type PasskeyQrCode, parsePasskeyQrCode } from "./passkey-qr-code";

describe("parsePasskeyQrCode", () => {
  const valid: PasskeyQrCode = {
    webContentsId: 3,
    relyingPartyId: "example.com",
    requestType: "create",
    qrCode: "FIDO:/123",
  };

  test("accepts a well-formed request", () => {
    expect(parsePasskeyQrCode(valid)).toEqual(valid);
  });

  test("rejects anything else", () => {
    expect(parsePasskeyQrCode(null)).toBeNull();
    expect(parsePasskeyQrCode("FIDO:/123")).toBeNull();
    expect(parsePasskeyQrCode({ ...valid, webContentsId: "3" })).toBeNull();
    expect(parsePasskeyQrCode({ ...valid, requestType: "sign" })).toBeNull();
    expect(parsePasskeyQrCode({ ...valid, qrCode: "https://example.com" })).toBeNull();
    expect(parsePasskeyQrCode({ ...valid, relyingPartyId: undefined })).toBeNull();
  });
});
