/**
 * LaunchServices helper process: the server executable started with
 * LAUNCH_SERVICES_HELPER_FLAG. Answers one JSON request per stdin line with one JSON
 * response per stdout line, and exits when stdin closes (i.e. when the server goes away).
 */
import { listAppsForFile, renderAppIcon } from "./launch-services-ffi";
import { HelperRequestSchema } from "./launch-services-protocol";
import type { HelperRequest, HelperResponse } from "./launch-services-protocol";

function execute(request: HelperRequest): unknown {
  switch (request.op) {
    case "apps":
      return listAppsForFile(request.path);
    case "icon":
      return Buffer.from(renderAppIcon(request.appPath)).toString("base64");
    default: {
      const unhandled: never = request;
      throw new Error(`Unhandled request: ${JSON.stringify(unhandled)}`);
    }
  }
}

function handleLine(line: string): HelperResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    process.stderr.write(`[launch-services-helper] ignoring malformed request line\n`);
    return null;
  }
  const request = HelperRequestSchema.safeParse(parsed);
  if (!request.success) {
    const id = typeof parsed === "object" && parsed && "id" in parsed ? parsed.id : undefined;
    if (typeof id !== "number") return null;
    return { id, ok: false, error: "Invalid request" };
  }
  try {
    return { id: request.data.id, ok: true, result: execute(request.data) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: request.data.id, ok: false, error: message };
  }
}

export async function runLaunchServicesHelper(): Promise<void> {
  if (process.platform !== "darwin") {
    process.stderr.write("[launch-services-helper] only supported on macOS\n");
    process.exit(1);
  }
  for await (const line of console) {
    if (!line.trim()) continue;
    const response = handleLine(line);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
  process.exit(0);
}
