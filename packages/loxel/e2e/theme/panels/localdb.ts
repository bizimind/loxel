import type { PanelShot } from "../lib";

const TABLE = "products";
const ROWS = [
  { name: "Nebula Mug", price: 18, category: "kitchen", in_stock: true, released: "2026-03-14" },
  { name: "Comet Hoodie", price: 49, category: "apparel", in_stock: false, released: "2026-05-02" },
  { name: "Lunar Lamp", price: 72, category: "home", in_stock: true, released: "2026-07-21" },
  { name: "Orbit Socks", price: 12, category: "apparel", in_stock: true, released: "2026-08-09" },
  { name: "Star Map Poster", price: 25, category: "home", in_stock: false, released: "2026-09-30" },
];

/** Database panel showing a small products table, staged through the localdb API. */
const shot: PanelShot = {
  description:
    "Database (localdb) panel in the center: table list sidebar with the products table selected, and its data grid with text, number, select (colored options), boolean and date columns",
  run: async (ctx) => {
    const { page, fixture } = ctx;
    const scope = `project=${encodeURIComponent(fixture)}`;
    // Create the table and its rows once; later runs find them and leave them as they are.
    const tables = (await ctx.api(`/api/localdb/tables?${scope}`)) as { name: string }[];
    if (!tables.some((t) => t.name === TABLE)) {
      await ctx.api(`/api/localdb/tables?${scope}`, {
        body: {
          name: TABLE,
          label: "Products",
          columns: [
            { kind: "text", label: "Name" },
            { kind: "number", label: "Price" },
            {
              kind: "text",
              label: "Category",
              options: {
                source: "inline",
                items: [
                  { value: "kitchen", label: "Kitchen", color: "orange", position: 0 },
                  { value: "apparel", label: "Apparel", color: "purple", position: 1 },
                  { value: "home", label: "Home", color: "green", position: 2 },
                ],
              },
            },
            { kind: "boolean", label: "In stock" },
            { kind: "date", label: "Released" },
          ],
        },
      });
    }
    const existing = (await ctx.api(`/api/localdb/tables/${TABLE}/query?${scope}`, {
      body: { pageSize: 1 },
    })) as { rows?: unknown[] };
    if (!existing.rows?.length) {
      for (const row of ROWS) {
        await ctx.api(`/api/localdb/tables/${TABLE}/rows?${scope}`, { body: row });
      }
    }
    await page.getByText("Database", { exact: true }).first().click();
    await page.getByText("Products", { exact: true }).first().click();
    await page.getByText("Star Map Poster").first().waitFor({ state: "visible" });
    await page.getByText("Lunar Lamp").first().click();
    await ctx.settle();
  },
};
export default shot;
