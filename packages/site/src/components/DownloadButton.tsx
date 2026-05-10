import { useState, useEffect } from "react";

interface Props {
  version: string;
  binaries: Record<string, string>;
}

type Platform = "mac-arm" | "mac-intel" | "other";

async function detectPlatform(): Promise<Platform> {
  if (typeof navigator === "undefined") return "mac-arm";
  if (!navigator.userAgent.includes("Mac") && !navigator.userAgent.includes("macOS"))
    return "other";
  try {
    const data = await navigator.userAgentData?.getHighEntropyValues(["architecture"]);
    return data?.architecture === "arm" ? "mac-arm" : "mac-intel";
  } catch {
    return navigator.userAgent.includes("Intel") ? "mac-intel" : "mac-arm";
  }
}

export default function DownloadButton({ version, binaries }: Props) {
  const [platform, setPlatform] = useState<Platform>("mac-arm");

  useEffect(() => {
    detectPlatform().then(setPlatform);
  }, []);

  const builds: Record<Platform, { label: string; url: string } | null> = {
    "mac-arm": binaries["darwin-arm64"]
      ? { label: "Download for macOS (Apple Silicon)", url: binaries["darwin-arm64"] }
      : null,
    "mac-intel": binaries["darwin-x64"]
      ? { label: "Download for macOS (Intel)", url: binaries["darwin-x64"] }
      : null,
    other: null,
  };

  const build = builds[platform];

  if (platform === "other") {
    return (
      <p className="text-muted-foreground text-sm">
        macOS only for now.{" "}
        <a
          href="/download"
          className="text-accent underline underline-offset-2 transition-opacity hover:opacity-75"
        >
          See all downloads
        </a>{" "}
        for updates.
      </p>
    );
  }

  if (!build) {
    const archLabel = platform === "mac-arm" ? "Apple Silicon" : "Intel";
    return (
      <p className="text-muted-foreground text-sm">
        No build available for macOS ({archLabel}) yet.{" "}
        <a
          href="/download"
          className="text-accent underline underline-offset-2 transition-opacity hover:opacity-75"
        >
          See all downloads
        </a>
        .
      </p>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <a
        href={build.url}
        className="bg-primary text-primary-foreground hover:bg-accent inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-sm font-semibold transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 12L3 7h3V1h4v6h3L8 12z" />
          <path d="M2 14h12v1.5H2z" />
        </svg>
        {build.label}
      </a>
      <span className="text-muted-foreground text-xs">v{version} · Free</span>
    </div>
  );
}
