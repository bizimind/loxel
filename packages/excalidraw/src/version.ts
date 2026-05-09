import pkg from "../package.json";

export function getCurrentVersion(): string {
  return pkg.version;
}
