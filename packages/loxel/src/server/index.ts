// Process entry point. The same executable doubles as the LaunchServices helper process
// (see launch-services-client.ts), so pick the role before loading any server modules.
import { LAUNCH_SERVICES_HELPER_FLAG } from "./launch-services-protocol";

if (process.argv.includes(LAUNCH_SERVICES_HELPER_FLAG)) {
  const { runLaunchServicesHelper } = await import("./launch-services-helper");
  await runLaunchServicesHelper();
} else {
  await import("./server");
}
