import type { IDockviewPanelHeaderProps } from "dockview-react";
import { DatabaseIcon } from "lucide-react";

import { Tab } from "./tab";

export function LocalDbTab(props: IDockviewPanelHeaderProps) {
  return (
    <Tab api={props.api} icon={<DatabaseIcon className="size-3.5 shrink-0" />} title="Database" />
  );
}
