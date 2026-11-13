import { create } from "zustand";

/**
 * Whether the Add Project wizard is open. Every way to add a project opens it through here, and
 * App mounts the one wizard, so it outlives the sidebar and empty state that open it.
 */
interface AddProjectWizardState {
  isOpen: boolean;
  /** Counts openings, so each one gets a fresh wizard. */
  session: number;
  open: () => void;
  close: () => void;
}

export const useAddProjectWizardStore = create<AddProjectWizardState>()((set) => ({
  isOpen: false,
  session: 0,
  open: () => set((state) => (state.isOpen ? state : { isOpen: true, session: state.session + 1 })),
  close: () => set({ isOpen: false }),
}));

/** Open the Add Project wizard. */
export function openAddProjectWizard(): void {
  useAddProjectWizardStore.getState().open();
}
