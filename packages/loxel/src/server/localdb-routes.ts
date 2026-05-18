import type { LocalDb } from "@bizimind/localdb-sdk";
import {
  parseColumnDef,
  parseColumnDefs,
  parseQueryOptions,
  parseRowPayload,
  parseViewDef,
} from "@bizimind/localdb-sdk";
import { ZodError } from "zod";

import { error, json } from "./response-helpers";

interface LocalDbRouteContext {
  localDb: LocalDb;
  onChange?: (change: LocalDbChange) => void;
}

interface LocalDbChange {
  tableName?: string;
  tableId?: number;
  scope: "schema" | "data" | "views";
}

// ── Schema ────────────────────────────────────────────────────────────────────

/** GET /api/localdb/tables */
function handleListTables(_req: Request, ctx: LocalDbRouteContext): Response {
  return json(ctx.localDb.schema.listTables());
}

/** GET /api/localdb/tables/:name/schema */
function handleGetSchema(req: Request, ctx: LocalDbRouteContext, name: string): Response {
  try {
    return json(ctx.localDb.schema.getTableSchema(name));
  } catch {
    return error(`Table not found: ${name}`, 404);
  }
}

function parseErrorResponse(e: unknown): Response {
  if (e instanceof ZodError) return error(`Invalid localdb payload: ${e.message}`, 400);
  return error(e instanceof Error ? e.message : "Request failed", 400);
}

function objectRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

/** POST /api/localdb/tables */
async function handleCreateTable(req: Request, ctx: LocalDbRouteContext): Promise<Response> {
  const body = objectRecord(await req.json());
  if (typeof body.name !== "string" || typeof body.label !== "string") {
    return error("name and label are required strings", 400);
  }
  try {
    const columns = parseColumnDefs(body.columns ?? []);
    const table = ctx.localDb.schema.createTable(body.name, body.label, columns);
    ctx.onChange?.({ tableName: table.name, tableId: table.id, scope: "schema" });
    return json(table, 201);
  } catch (e) {
    return parseErrorResponse(e);
  }
}

/** DELETE /api/localdb/tables/:name */
function handleDropTable(_req: Request, ctx: LocalDbRouteContext, name: string): Response {
  try {
    ctx.localDb.schema.dropTable(name);
    ctx.onChange?.({ tableName: name, scope: "schema" });
    return new Response(null, { status: 204 });
  } catch {
    return error(`Table not found: ${name}`, 404);
  }
}

/** POST /api/localdb/tables/:name/columns */
async function handleAddColumn(
  req: Request,
  ctx: LocalDbRouteContext,
  name: string,
): Promise<Response> {
  try {
    const def = parseColumnDef(await req.json());
    ctx.localDb.schema.addColumn(name, def);
    const schema = ctx.localDb.schema.getTableSchema(name);
    ctx.onChange?.({ tableName: name, tableId: schema.table.id, scope: "schema" });
    return json(schema);
  } catch (e) {
    return parseErrorResponse(e);
  }
}

/** DELETE /api/localdb/tables/:name/columns/:colName */
function handleDropColumn(
  _req: Request,
  ctx: LocalDbRouteContext,
  tableName: string,
  colName: string,
): Response {
  try {
    ctx.localDb.schema.dropColumn(tableName, colName);
    const schema = ctx.localDb.schema.getTableSchema(tableName);
    ctx.onChange?.({ tableName, tableId: schema.table.id, scope: "schema" });
    return json(schema);
  } catch (e) {
    return error(e instanceof Error ? e.message : "Drop column failed", 400);
  }
}

/** POST /api/localdb/tables/:name/columns/:colName/plan-alter */
async function handlePlanAlter(
  req: Request,
  ctx: LocalDbRouteContext,
  tableName: string,
  colName: string,
): Promise<Response> {
  try {
    const body = await req.json();
    const record = objectRecord(body);
    const newDef = parseColumnDef("newDef" in record ? record.newDef : body);
    const plan = ctx.localDb.schema.planAlterColumn(tableName, colName, newDef);
    return json(plan);
  } catch (e) {
    return parseErrorResponse(e);
  }
}

/** POST /api/localdb/tables/:name/columns/:colName/apply-migration */
async function handleApplyMigration(
  req: Request,
  ctx: LocalDbRouteContext,
  tableName: string,
  colName: string,
): Promise<Response> {
  // Accept only the new column definition from the client; re-derive the plan
  // server-side using the authoritative path params to prevent plan tampering.
  const body = objectRecord(await req.json());
  if (!body.newDef || typeof body.newDef !== "object") {
    return error("newDef is required", 400);
  }
  try {
    const plan = ctx.localDb.schema.planAlterColumn(
      tableName,
      colName,
      parseColumnDef(body.newDef),
    );
    const result = ctx.localDb.schema.applyMigration(plan);
    const schema = ctx.localDb.schema.getTableSchema(tableName);
    ctx.onChange?.({ tableName, tableId: schema.table.id, scope: "schema" });
    return json(result);
  } catch (e) {
    return parseErrorResponse(e);
  }
}

// ── Data ──────────────────────────────────────────────────────────────────────

/** POST /api/localdb/tables/:name/query */
async function handleQuery(
  req: Request,
  ctx: LocalDbRouteContext,
  name: string,
): Promise<Response> {
  try {
    const opts = parseQueryOptions(await req.json());
    const schema = ctx.localDb.schema.getTableSchema(name);
    const columns = schema.columns.map((c) => ({ name: c.name, def: c.def, id: c.id }));
    const page = ctx.localDb.data.list(name, columns, opts);
    return json(page);
  } catch (e) {
    return parseErrorResponse(e);
  }
}

/** GET /api/localdb/tables/:name/rows/:id */
function handleGetRow(
  _req: Request,
  ctx: LocalDbRouteContext,
  tableName: string,
  id: string,
): Response {
  try {
    const schema = ctx.localDb.schema.getTableSchema(tableName);
    const columns = schema.columns.map((c) => ({ name: c.name, def: c.def, id: c.id }));
    const row = ctx.localDb.data.get(tableName, Number(id), columns);
    if (!row) return error("Row not found", 404);
    return json(row);
  } catch (e) {
    return error(e instanceof Error ? e.message : "Get row failed", 400);
  }
}

/** POST /api/localdb/tables/:name/rows */
async function handleInsertRow(
  req: Request,
  ctx: LocalDbRouteContext,
  tableName: string,
): Promise<Response> {
  try {
    const row = parseRowPayload(await req.json());
    const schema = ctx.localDb.schema.getTableSchema(tableName);
    const columns = schema.columns.map((c) => ({ name: c.name, def: c.def, id: c.id }));
    const result = ctx.localDb.data.insert(tableName, row, columns);
    if (result.ok) ctx.onChange?.({ tableName, tableId: schema.table.id, scope: "data" });
    return json(result, result.ok ? 201 : 422);
  } catch (e) {
    return parseErrorResponse(e);
  }
}

/** PATCH /api/localdb/tables/:name/rows/:id */
async function handleUpdateRow(
  req: Request,
  ctx: LocalDbRouteContext,
  tableName: string,
  id: string,
): Promise<Response> {
  try {
    const patch = parseRowPayload(await req.json());
    const schema = ctx.localDb.schema.getTableSchema(tableName);
    const columns = schema.columns.map((c) => ({ name: c.name, def: c.def, id: c.id }));
    const result = ctx.localDb.data.update(tableName, Number(id), patch, columns);
    if (result.ok) ctx.onChange?.({ tableName, tableId: schema.table.id, scope: "data" });
    return json(result, result.ok ? 200 : 422);
  } catch (e) {
    return parseErrorResponse(e);
  }
}

/** DELETE /api/localdb/tables/:name/rows/:id */
function handleDeleteRow(
  _req: Request,
  ctx: LocalDbRouteContext,
  tableName: string,
  id: string,
): Response {
  try {
    ctx.localDb.data.delete(tableName, Number(id));
    const schema = ctx.localDb.schema.getTableSchema(tableName);
    ctx.onChange?.({ tableName, tableId: schema.table.id, scope: "data" });
    return new Response(null, { status: 204 });
  } catch (e) {
    return error(e instanceof Error ? e.message : "Delete failed", 400);
  }
}

// ── Views ─────────────────────────────────────────────────────────────────────

/** GET /api/localdb/views?tableId=N */
function handleListViews(req: Request, ctx: LocalDbRouteContext): Response {
  const url = new URL(req.url);
  const tableId = Number(url.searchParams.get("tableId"));
  if (!tableId) return error("tableId query param required", 400);
  return json(ctx.localDb.views.listViews(tableId));
}

/** POST /api/localdb/views */
async function handleCreateView(req: Request, ctx: LocalDbRouteContext): Promise<Response> {
  const body = objectRecord(await req.json());
  if (typeof body.tableId !== "number" || typeof body.name !== "string" || !body.config) {
    return error("tableId (number), name, and config are required", 400);
  }
  try {
    const view = ctx.localDb.views.createView(body.tableId, body.name, parseViewDef(body.config));
    ctx.onChange?.({ tableId: view.tableId, scope: "views" });
    return json(view, 201);
  } catch (e) {
    return parseErrorResponse(e);
  }
}

/** PATCH /api/localdb/views/:id */
async function handleUpdateView(
  req: Request,
  ctx: LocalDbRouteContext,
  id: string,
): Promise<Response> {
  const body = objectRecord(await req.json());
  try {
    const patch = {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(body.config ? { config: parseViewDef(body.config) } : {}),
    };
    const view = ctx.localDb.views.updateView(Number(id), patch);
    ctx.onChange?.({ tableId: view.tableId, scope: "views" });
    return json(view);
  } catch (e) {
    if (e instanceof ZodError) return parseErrorResponse(e);
    return error(`View not found: ${id}`, 404);
  }
}

/** DELETE /api/localdb/views/:id */
function handleDeleteView(_req: Request, ctx: LocalDbRouteContext, id: string): Response {
  try {
    const view = ctx.localDb.views.getView(Number(id));
    ctx.localDb.views.deleteView(Number(id));
    ctx.onChange?.({ tableId: view.tableId, scope: "views" });
    return new Response(null, { status: 204 });
  } catch {
    return error(`View not found: ${id}`, 404);
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export function handleLocalDbRequest(
  req: Request,
  ctx: LocalDbRouteContext,
): Response | Promise<Response> | null {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/localdb/, "");
  const method = req.method;

  // /tables
  if (path === "/tables" && method === "GET") return handleListTables(req, ctx);
  if (path === "/tables" && method === "POST") return handleCreateTable(req, ctx);

  // /tables/:name
  const tableMatch = path.match(/^\/tables\/([^/]+)$/);
  if (tableMatch?.[1]) {
    const name = tableMatch[1];
    if (method === "GET") return handleGetSchema(req, ctx, name);
    if (method === "DELETE") return handleDropTable(req, ctx, name);
  }

  // /tables/:name/schema
  const schemaMatch = path.match(/^\/tables\/([^/]+)\/schema$/);
  if (schemaMatch?.[1] && method === "GET") return handleGetSchema(req, ctx, schemaMatch[1]);

  // /tables/:name/query
  const queryMatch = path.match(/^\/tables\/([^/]+)\/query$/);
  if (queryMatch?.[1] && method === "POST") return handleQuery(req, ctx, queryMatch[1]);

  // /tables/:name/rows
  const rowsMatch = path.match(/^\/tables\/([^/]+)\/rows$/);
  if (rowsMatch?.[1]) {
    if (method === "POST") return handleInsertRow(req, ctx, rowsMatch[1]);
  }

  // /tables/:name/rows/:id
  const rowMatch = path.match(/^\/tables\/([^/]+)\/rows\/(\d+)$/);
  if (rowMatch?.[1] && rowMatch[2]) {
    const [, tName, id] = rowMatch;
    if (method === "GET") return handleGetRow(req, ctx, tName, id);
    if (method === "PATCH") return handleUpdateRow(req, ctx, tName, id);
    if (method === "DELETE") return handleDeleteRow(req, ctx, tName, id);
  }

  // /tables/:name/columns
  const colsMatch = path.match(/^\/tables\/([^/]+)\/columns$/);
  if (colsMatch?.[1] && method === "POST") return handleAddColumn(req, ctx, colsMatch[1]);

  // /tables/:name/columns/:colName
  const colMatch = path.match(/^\/tables\/([^/]+)\/columns\/([^/]+)$/);
  if (colMatch?.[1] && colMatch[2] && method === "DELETE") {
    return handleDropColumn(req, ctx, colMatch[1], colMatch[2]);
  }

  // /tables/:name/columns/:colName/plan-alter
  const planAlterMatch = path.match(/^\/tables\/([^/]+)\/columns\/([^/]+)\/plan-alter$/);
  if (planAlterMatch?.[1] && planAlterMatch[2] && method === "POST") {
    return handlePlanAlter(req, ctx, planAlterMatch[1], planAlterMatch[2]);
  }

  // /tables/:name/columns/:colName/apply-migration
  const applyMatch = path.match(/^\/tables\/([^/]+)\/columns\/([^/]+)\/apply-migration$/);
  if (applyMatch?.[1] && applyMatch[2] && method === "POST") {
    return handleApplyMigration(req, ctx, applyMatch[1], applyMatch[2]);
  }

  // /views
  if (path === "/views" && method === "GET") return handleListViews(req, ctx);
  if (path === "/views" && method === "POST") return handleCreateView(req, ctx);

  // /views/:id
  const viewMatch = path.match(/^\/views\/(\d+)$/);
  if (viewMatch?.[1]) {
    const id = viewMatch[1];
    if (method === "PATCH") return handleUpdateView(req, ctx, id);
    if (method === "DELETE") return handleDeleteView(req, ctx, id);
  }

  return null;
}
