import packageJson from "../package.json";

export function getCurrentVersion(): string {
  return packageJson.version;
}
