import { appendFile } from "node:fs/promises";

export async function appendJsonl(filePath: string, payload: unknown): Promise<void> {
  const line = `${JSON.stringify(payload)}\n`;
  await appendFile(filePath, line, { encoding: "utf8" });
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return [];
  }

  const text = await file.text();
  const rows: T[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    try {
      rows.push(JSON.parse(line) as T);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSONL line ${index + 1} in ${filePath}: ${reason}`);
    }
  }

  return rows;
}
