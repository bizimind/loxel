import { FolderOpenIcon } from "lucide-react";

import { openAddProjectWizard } from "@/store/add-project-wizard";

import { Button } from "./ui/button";

export function EmptyState() {
  return (
    <div className="bg-background flex h-full items-center justify-center">
      <div className="flex max-w-sm flex-col items-center gap-6 text-center">
        <FolderOpenIcon className="text-muted-foreground size-12" />
        <div>
          <h2 className="text-foreground text-lg font-medium">No project open</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Open a git repository or create a new project to get started.
          </p>
        </div>

        <Button onClick={openAddProjectWizard}>
          <FolderOpenIcon className="mr-2 size-4" />
          Add Project
        </Button>
      </div>
    </div>
  );
}
