import type { TerminalEnd, TerminalNotice } from "@/api/ws-protocol";

/** What a terminal panel prints, in brackets, when its session ends. */
export function terminalEndMessage(end: TerminalEnd): string {
  if (end.reason === "host_lost")
    return "Terminal ended: Loxel's terminal host stopped unexpectedly";
  const exited =
    end.exitCode === null ? "Process exited" : `Process exited with code ${end.exitCode}`;
  if (!end.outputLost) return exited;
  return `${exited} while Loxel was away; its last output was not kept`;
}

/** What a terminal panel prints, in brackets, for a notice about its running session. */
export function terminalNoticeMessage(notice: TerminalNotice): string {
  if (notice.notice === "attach_failed") return `Could not open the terminal: ${notice.message}`;
  return "Loxel's terminal host is not responding; this terminal continues once it does";
}
