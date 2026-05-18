import { $remark } from "@milkdown/kit/utils";
import type { Root } from "mdast";
import remarkDirective from "remark-directive";
import { visit } from "unist-util-visit";

/** Wraps remark-directive and converts :::localdb container directives to localdb-block nodes. */
export const remarkLocalDbPlugin = $remark("remark-localdb", () => () => (tree: Root) => {
  visit(tree, (node: { type: string; name?: string }) => {
    if (node.type !== "containerDirective") return;
    if (node.name !== "localdb") return;
    node.type = "localdb-block";
  });
});

/** Must be installed before remarkLocalDbPlugin so the AST nodes exist. */
export const remarkDirectivePlugin = $remark("remark-directive", () => remarkDirective);
