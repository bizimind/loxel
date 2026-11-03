import type { IDockviewHeaderActionsProps } from "dockview-react";
import { Minimize2Icon } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";

import { maximizeGroupLabel } from "@/lib/center-maximize";

/** Header button of a maximized center group, which also shows that other groups are hidden. */
export function MaximizedGroupActions({ api, containerApi }: IDockviewHeaderActionsProps) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const disposable = containerApi.onDidMaximizedGroupChange(onChange);
      return () => disposable.dispose();
    },
    [containerApi],
  );
  const isMaximized = useSyncExternalStore(subscribe, () => api.isMaximized());
  if (!isMaximized) return null;

  const label = maximizeGroupLabel(true);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="text-muted-foreground hover:text-foreground flex h-full items-center px-2"
      onClick={() => api.exitMaximized()}
    >
      <Minimize2Icon className="size-3.5" />
    </button>
  );
}
