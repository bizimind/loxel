import { FolderOpenIcon } from "lucide-react";
import { useState } from "react";

import { AddProjectWizard } from "./projects/AddProjectWizard";
import { Button } from "./ui/button";
import { ToastContainer } from "./ui/toast";

export function EmptyState() {
  const [wizardOpen, setWizardOpen] = useState(false);

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

        <Button onClick={() => setWizardOpen(true)}>
          <FolderOpenIcon className="mr-2 size-4" />
          Add Project
        </Button>

        <AddProjectWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
        <ToastContainer />
      </div>
    </div>
  );
}
