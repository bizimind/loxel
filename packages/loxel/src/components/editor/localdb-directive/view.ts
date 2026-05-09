import type { NodeViewConstructor } from "@milkdown/kit/prose/view";

import { $view } from "@milkdown/kit/utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { queryClient } from "@/query-client";

import { LocalDbWidget } from "./LocalDbWidget.tsx";
import { localDbBlockSchema } from "./schema.ts";

export const localDbBlockView = $view(
  localDbBlockSchema.node,
  (_ctx): NodeViewConstructor =>
    (initialNode, view, getPos) => {
      const dom = document.createElement("div");
      dom.className = "milkdown-localdb-block";
      dom.setAttribute("contenteditable", "false");

      const root = createRoot(dom);
      let currentNode = initialNode;

      function updateAttrs(attrs: { table?: string; view?: string; viewId?: number | null }) {
        const pos = getPos();
        if (pos === undefined) return;
        view.dispatch(
          view.state.tr.setNodeMarkup(pos, undefined, { ...currentNode.attrs, ...attrs }),
        );
      }

      function render(node: typeof initialNode) {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(LocalDbWidget, {
              table: node.attrs.table as string,
              view: node.attrs.view as string,
              viewId: node.attrs.viewId as number | null,
              onUpdateAttrs: updateAttrs,
            }),
          ),
        );
      }

      render(initialNode);

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== "localdb-block") return false;
          currentNode = updatedNode;
          render(updatedNode);
          return true;
        },
        stopEvent() {
          return true;
        },
        ignoreMutation() {
          return true;
        },
        destroy() {
          root.unmount();
        },
      };
    },
);
