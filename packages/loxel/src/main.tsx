import "./index.css";
import "@/lib/monaco-env";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { fetchLocalServerId } from "./api/client";
import { setLocalServerId } from "./api/local-server";
import App from "./App";
import { frontendLog } from "./lib/frontend-logger";
import { startPerfMonitor } from "./lib/perf-monitor";
import { initSaveOutbox } from "./lib/save-outbox";
import { queryClient } from "./query-client";

const log = frontendLog.child("ui");

window.addEventListener("error", (event) => {
  log.error("Uncaught error", {
    error: event.error instanceof Error ? event.error : undefined,
    message: event.error instanceof Error ? undefined : String(event.error || event.message),
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  // Monaco cancels work it never awaits, such as the references peek's list refresh when the peek
  // closes. Like VS Code, which ignores them, a cancellation is not an error.
  const { reason } = event;
  if (reason instanceof Error && reason.name === "Canceled" && reason.message === "Canceled") {
    event.preventDefault();
    return;
  }
  log.error("Unhandled promise rejection", {
    error: event.reason instanceof Error ? event.reason : undefined,
    message: event.reason instanceof Error ? undefined : String(event.reason),
  });
});

startPerfMonitor();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// Rendered once the save outbox has loaded, so a tab restored with the layout can take over a
// save of its file that an earlier run left unsent. Never holds the app back for long.
const OUTBOX_INIT_WAIT_MS = 2_000;
// Every query key names the server, so the app also waits until it knows which one it talks to.
const serverKnown = fetchLocalServerId().then(setLocalServerId);
void Promise.race([
  initSaveOutbox(),
  new Promise((resolve) => {
    setTimeout(resolve, OUTBOX_INIT_WAIT_MS);
  }),
]).finally(async () => {
  await serverKnown;
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
});
