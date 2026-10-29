import "./index.css";
import "@/lib/monaco-env";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { frontendLog } from "./lib/frontend-logger";
import { startPerfMonitor } from "./lib/perf-monitor";
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

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
