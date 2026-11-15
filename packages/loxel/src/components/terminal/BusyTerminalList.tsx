import type { BusyTerminal } from "@/lib/busy-terminals";

/** The terminals with a program running, as the update and quit confirmations list them. */
export function BusyTerminalList({ busy }: { busy: readonly BusyTerminal[] }) {
  return (
    <ul className="space-y-0.5">
      {busy.map((terminal) => (
        <li key={terminal.id} className="text-foreground">
          <span className="font-mono">{terminal.program}</span>
          <span className="text-muted-foreground"> in {terminal.worktree}</span>
        </li>
      ))}
    </ul>
  );
}
