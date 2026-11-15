import type { IDockviewPanelHeaderProps } from "dockview-react";

import { FileTypeIcon } from "@/lib/file-icons";
import { virtualDocumentFileName, virtualDocumentPath } from "@/lib/virtual-documents";

import { Tab, usePanelTitle } from "./tab";

/** The tab of a language server's read-only document, which has no path or file actions. */
export function VirtualDocumentTab(props: IDockviewPanelHeaderProps<{ uri: string }>) {
  return (
    <Tab
      api={props.api}
      icon={
        <FileTypeIcon
          filename={virtualDocumentFileName(props.params.uri)}
          className="size-3.5 shrink-0"
        />
      }
      title={usePanelTitle(props.api) ?? ""}
      titleTooltip={`${virtualDocumentPath(props.params.uri)} (read-only)`}
    />
  );
}
