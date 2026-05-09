export type Platform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

export function getCurrentPlatform(): Platform {
  const os = process.platform;
  const arch = process.arch;

  if (os === "darwin" && arch === "arm64") return "darwin-arm64";
  if (os === "darwin" && arch === "x64") return "darwin-x64";
  if (os === "linux" && arch === "x64") return "linux-x64";
  if (os === "linux" && arch === "arm64") return "linux-arm64";

  throw new Error(`Unsupported platform: ${os}-${arch}`);
}
