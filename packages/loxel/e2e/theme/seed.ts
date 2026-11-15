/**
 * Seed a freshly started theme stack (run by `stack.sh`): add the fixture project, set the light
 * theme before any page loads (the harness never changes it), and mark the server as this stack's
 * so `shoot.ts` can tell it from a developer's own dev server. Usage: `bun e2e/theme/seed.ts <work-dir>`.
 */
import { useSettingsStore } from "@/store/settings-store";

import { api, fixturePath, STACK_TOKEN_KEY, stackTokenPath } from "./lib";

const workDir = process.argv[2];
if (!workDir) throw new Error("usage: bun e2e/theme/seed.ts <work-dir>");

await api("/api/projects", { body: { path: fixturePath(workDir), name: "orbit-shop" } });
const { version } = useSettingsStore.persist.getOptions();
await api("/api/stores/settings", {
  method: "PUT",
  body: { value: JSON.stringify({ state: { theme: "light" }, version }) },
});
const token = crypto.randomUUID();
await api(`/api/stores/${STACK_TOKEN_KEY}`, { method: "PUT", body: { value: token } });
await Bun.write(stackTokenPath(workDir), token);
