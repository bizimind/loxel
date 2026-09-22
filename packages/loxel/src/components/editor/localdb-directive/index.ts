import type { MilkdownPlugin } from "@milkdown/kit/ctx";

import { remarkLocalDbPlugin } from "./remark-plugin.ts";
import { localDbBlockSchema } from "./schema.ts";
import { localDbBlockView } from "./view.ts";

/** All Milkdown plugins needed for :::localdb directive support. Install via crepe.editor.use(). */
export const localDbDirectivePlugins: MilkdownPlugin[] = [
  remarkLocalDbPlugin,
  localDbBlockSchema,
  localDbBlockView,
].flat();
