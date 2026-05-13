import path from "node:path";

export function resolvePackage(name: string, from?: string): string {
  const paths = from ? [from] : undefined;
  const pkgJson = require.resolve(`${name}/package.json`, { paths });
  return path.dirname(pkgJson);
}
