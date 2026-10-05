import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/** Shared by the root menu and submenus so they look identical. */
const POPUP_CLASS_NAME =
  "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 ring-foreground/10 bg-popover text-popover-foreground z-50 min-w-36 overflow-hidden rounded-md p-1 shadow-md ring-1 duration-100 outline-none";

interface ContextMenuProps {
  children: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  position: { x: number; y: number };
}

function ContextMenu({ children, open, onOpenChange, position }: ContextMenuProps) {
  const triggerId = React.useId();

  return (
    <MenuPrimitive.Root open={open} onOpenChange={onOpenChange} triggerId={triggerId}>
      {/*
        The menu opens at the pointer (see `anchor`), so this trigger is never interacted with.
        It exists because Base UI registers a top-level menu in its floating tree through its
        trigger; without one, opening a submenu is treated as a sibling menu opening and closes
        the whole context menu. Because the menu is opened programmatically, Base UI still
        returns focus to the element focused before it opened, not to this trigger.
      */}
      <MenuPrimitive.Trigger
        id={triggerId}
        nativeButton={false}
        render={<span />}
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none fixed size-0 opacity-0"
      />
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          className="isolate z-50 outline-none"
          side="bottom"
          align="start"
          anchor={{
            getBoundingClientRect: () => ({
              x: position.x,
              y: position.y,
              width: 0,
              height: 0,
              top: position.y,
              left: position.x,
              right: position.x,
              bottom: position.y,
              toJSON: () => {},
            }),
          }}
        >
          <MenuPrimitive.Popup data-slot="context-menu-content" className={POPUP_CLASS_NAME}>
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & { inset?: boolean; variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:bg-primary data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive group/context-menu-item relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-hidden select-none data-disabled:pointer-events-none data-disabled:cursor-default data-disabled:opacity-50 data-inset:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

function ContextMenuLabel({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<"div"> & { inset?: boolean }) {
  return (
    <div
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(
        "text-muted-foreground px-2 py-1.5 text-xs font-semibold data-inset:pl-8",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      className={cn(
        "focus:bg-primary relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-xs outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex items-center justify-center">
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon className="size-4" />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function ContextMenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />;
}

function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      className={cn(
        "focus:bg-primary data-open:bg-primary flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-hidden select-none data-disabled:pointer-events-none data-disabled:cursor-default data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function ContextMenuSubContent({ children }: { children: React.ReactNode }) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        side="right"
        align="start"
        alignOffset={-4}
      >
        <MenuPrimitive.Popup data-slot="context-menu-sub-content" className={POPUP_CLASS_NAME}>
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn("text-muted-foreground ml-auto text-xs tracking-widest", className)}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
  ContextMenuCheckboxItem,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
};
