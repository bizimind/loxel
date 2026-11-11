import type { PanelShot } from "../lib";
import media from "./media";

/** The media viewer's SVG after the toolbar's actual-size (1:1) action. */
const shot: PanelShot = {
  description:
    "Media viewer showing the SVG badge after the toolbar's actual-size (1:1) action, with the zoom percentage it reads at that size",
  run: async (ctx) => {
    await media.run(ctx);
    await ctx.page.locator('[title="Actual size"]:visible').first().click();
    await ctx.settle();
  },
};
export default shot;
