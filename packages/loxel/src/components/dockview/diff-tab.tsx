import type { IDockviewPanelHeaderProps } from "dockview-react";
import { DiffIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useDiffTitle } from "@/hooks/useDiffTitle";

import { Tab } from "./tab";

export function DiffTab(props: IDockviewPanelHeaderProps) {
  const diffTitle = useDiffTitle();
  const [title, setTitle] = useState(diffTitle);

  useEffect(() => {
    setTitle(diffTitle);
    props.api.setTitle(diffTitle);
  }, [diffTitle, props.api]);

  return <Tab api={props.api} icon={<DiffIcon className="size-3.5 shrink-0" />} title={title} />;
}
