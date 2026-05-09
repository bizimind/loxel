import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

import type { Project, ProjectsData } from "@/api/project-model";

import { config } from "./config";
import { getGitRoot, isBareRepo } from "./git-commands";
import { logger } from "./logger";

const log = logger.child("server");

const DB_PATH = join(config.stateDir, "projects.db");
const LEGACY_JSON_PATH = join(config.stateDir, "projects.json");

const ProjectRowSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  added_at: z.string(),
});

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;

  if (!existsSync(config.stateDir)) {
    mkdirSync(config.stateDir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    added_at TEXT NOT NULL
  )`);
  return db;
}

/** Migrate from legacy projects.json to SQLite (one-time, idempotent). */
async function migrateFromJson(): Promise<void> {
  if (!existsSync(LEGACY_JSON_PATH)) return;

  const d = getDb();
  const { cnt } = z
    .object({ cnt: z.number() })
    .parse(d.prepare("SELECT COUNT(*) as cnt FROM projects").get());
  if (cnt > 0) return;

  let projects: { id: string; path: string; name: string; addedAt: string }[];
  try {
    const text = await Bun.file(LEGACY_JSON_PATH).text();
    const raw: unknown = JSON.parse(text);
    const data = z
      .object({
        projects: z.array(
          z.object({ id: z.string(), path: z.string(), name: z.string(), addedAt: z.string() }),
        ),
      })
      .parse(raw);
    projects = data.projects;
  } catch (err) {
    log.warn("Failed to parse projects.json for migration, skipping", { error: err });
    return;
  }

  const insert = d.prepare(
    "INSERT OR IGNORE INTO projects (id, path, name, added_at) VALUES (?, ?, ?, ?)",
  );
  d.transaction(() => {
    for (const p of projects) {
      insert.run(p.id, p.path, p.name, p.addedAt);
    }
  })();

  try {
    renameSync(LEGACY_JSON_PATH, `${LEGACY_JSON_PATH}.bak`);
  } catch {
    // Another process may have renamed it
  }

  log.info(`Migrated ${projects.length} project(s) from projects.json to SQLite`);
}

export async function loadProjects(): Promise<ProjectsData> {
  await migrateFromJson();

  const rows = getDb()
    .prepare("SELECT id, path, name, added_at FROM projects")
    .all()
    .map((raw) => ProjectRowSchema.parse(raw));

  const projects: Project[] = [];
  for (const row of rows) {
    let isBare = false;
    try {
      isBare = await isBareRepo(row.path);
    } catch {
      // Keep project with default isBare=false for unreachable paths
    }
    projects.push({ id: row.id, path: row.path, name: row.name, addedAt: row.added_at, isBare });
  }
  return { projects };
}

export async function addProject(path: string, name?: string): Promise<Project> {
  const resolvedPath = await getGitRoot(path);
  const d = getDb();

  // INSERT OR IGNORE handles the race where two processes add the same path concurrently.
  // The loser's insert is silently ignored, and the re-SELECT below returns the winner's row.
  const id = crypto.randomUUID();
  const projectName = name ?? basename(resolvedPath);
  const addedAt = new Date().toISOString();
  d.prepare("INSERT OR IGNORE INTO projects (id, path, name, added_at) VALUES (?, ?, ?, ?)").run(
    id,
    resolvedPath,
    projectName,
    addedAt,
  );

  const row = ProjectRowSchema.parse(
    d.prepare("SELECT id, path, name, added_at FROM projects WHERE path = ?").get(resolvedPath),
  );

  let isBare = false;
  try {
    isBare = await isBareRepo(resolvedPath);
  } catch {
    // default false
  }
  return { id: row.id, path: row.path, name: row.name, addedAt: row.added_at, isBare };
}

export async function removeProject(id: string): Promise<void> {
  getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
}

export async function updateProject(id: string, updates: { name?: string }): Promise<Project> {
  const d = getDb();

  if (updates.name !== undefined) {
    d.prepare("UPDATE projects SET name = ? WHERE id = ?").run(updates.name, id);
  }

  const raw = d.prepare("SELECT id, path, name, added_at FROM projects WHERE id = ?").get(id);
  if (!raw) throw new Error(`Project not found: ${id}`);
  const row = ProjectRowSchema.parse(raw);

  let isBare = false;
  try {
    isBare = await isBareRepo(row.path);
  } catch {
    // default false
  }
  return { id: row.id, path: row.path, name: row.name, addedAt: row.added_at, isBare };
}
