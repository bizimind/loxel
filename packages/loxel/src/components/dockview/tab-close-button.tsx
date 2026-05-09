import type { DockviewPanelApi } from "dockview-react";

/** Shared close button for custom dockview tabs. */
export function TabCloseButton({ api }: { api: DockviewPanelApi }) {
  return (
    <div
      className="dv-default-tab-action"
      onClick={(e) => {
        e.stopPropagation();
        api.close();
      }}
    >
      <svg
        height="11"
        width="11"
        viewBox="0 0 28 28"
        aria-hidden="false"
        focusable="false"
        className="dv-svg"
      >
        <path d="M2.1 27.3L0 25.2L11.55 13.65L0 2.1L2.1 0L13.65 11.55L25.2 0L27.3 2.1L15.75 13.65L27.3 25.2L25.2 27.3L13.65 15.75L2.1 27.3Z" />
      </svg>
    </div>
  );
}
