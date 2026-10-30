import type {
  RustToolchainCandidatesResponse,
  RustToolchainResponse,
} from "@/api/rust-toolchain-model";

import { error, json } from "./response-helpers";
import { getRustToolchain, listRustToolchains, resolveRustToolchain } from "./rust-toolchain";
import { getRustChoice, setRustChoice } from "./rust-toolchain-store";

export interface RustToolchainRouteContext {
  /** The validated worktree of the request's `wt` parameter. */
  worktreeFromQuery: () => Promise<string | Response>;
  /** The validated worktree of the body's `worktreePath`. */
  worktreeFromBody: (body: Record<string, unknown>) => Promise<string | Response>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function toolchainResponse(wtPath: string): Promise<RustToolchainResponse> {
  return { toolchain: await getRustToolchain(wtPath), chosen: getRustChoice(wtPath) };
}

/** Rust toolchain routes; null when the request is none of them. */
export async function handleRustToolchainRequest(
  req: Request,
  pathname: string,
  ctx: RustToolchainRouteContext,
): Promise<Response | null> {
  // GET /api/rust-toolchain?wt= — The toolchain Loxel uses for a worktree
  if (pathname === "/api/rust-toolchain" && req.method === "GET") {
    const wtPath = await ctx.worktreeFromQuery();
    if (wtPath instanceof Response) return wtPath;
    return json(await toolchainResponse(wtPath));
  }

  // GET /api/rust-toolchain/candidates?wt= — Toolchains the user can choose for a worktree
  if (pathname === "/api/rust-toolchain/candidates" && req.method === "GET") {
    const wtPath = await ctx.worktreeFromQuery();
    if (wtPath instanceof Response) return wtPath;
    const [candidates, automatic] = await Promise.all([
      listRustToolchains(wtPath),
      resolveRustToolchain(wtPath, { chosen: null }),
    ]);
    const response: RustToolchainCandidatesResponse = {
      candidates,
      automatic,
      chosen: getRustChoice(wtPath),
    };
    return json(response);
  }

  // POST /api/rust-toolchain/choice — Choose a worktree's toolchain, or (null) return to detection
  if (pathname === "/api/rust-toolchain/choice" && req.method === "POST") {
    const body: unknown = await req.json().catch(() => null);
    if (!isJsonObject(body)) return error("Request body must be a JSON object", 400);
    const wtPath = await ctx.worktreeFromBody(body);
    if (wtPath instanceof Response) return wtPath;
    const { toolchain } = body;
    if (toolchain !== null && typeof toolchain !== "string") {
      return error("toolchain must be a string or null", 400);
    }
    if (toolchain !== null) {
      const installed = await listRustToolchains(wtPath);
      if (!installed.some((choice) => choice.name === toolchain)) {
        return error(`${toolchain} is not an installed Rust toolchain Loxel can use`, 400);
      }
    }
    setRustChoice(wtPath, toolchain);
    return json(await toolchainResponse(wtPath));
  }

  return null;
}
