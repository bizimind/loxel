import type { MilkdownPlugin } from "@milkdown/kit/ctx";

import { remarkDirectivePlugin, remarkLocalDbPlugin } from "./remark-plugin.ts";
import { localDbBlockSchema } from "./schema.ts";
import { localDbBlockView } from "./view.ts";

/** All Milkdown plugins needed for :::localdb directive support. Install via crepe.editor.use(). */
export const localDbDirectivePlugins: MilkdownPlugin[] = [
  remarkDirectivePlugin,
  remarkLocalDbPlugin,
  localDbBlockSchema,
  localDbBlockView,
].flat();
