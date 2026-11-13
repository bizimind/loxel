import type { TerminalEnd } from "@/api/ws-protocol";

/** What a terminal panel prints, in brackets, when its session ends. */
export function terminalEndMessage(end: TerminalEnd): string {
  if (end.reason === "host_lost")
    return "Terminal ended: Loxel's terminal host stopped unexpectedly";
  const exited =
    end.exitCode === null ? "Process exited" : `Process exited with code ${end.exitCode}`;
  if (!end.outputLost) return exited;
  return `${exited} while Loxel was away; its last output was not kept`;
}
