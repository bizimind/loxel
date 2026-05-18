import { describe, expect, test } from "bun:test";

import type { ContainerInfo } from "../src/container-info.ts";
import { ContainerNotFoundError, SandboxError } from "../src/errors.ts";
import type { ExecHandle } from "../src/exec-handle.ts";
import type {
  ExecOptions,
  ExecResult,
  ListFilter,
  RunContainerOptions,
  SandboxProvider,
  SpawnOptions,
} from "../src/provider.ts";
import { SandboxSpecSchema } from "../src/sandbox-spec.ts";
import { SandboxTemplate, SDK_LABEL, SDK_LABEL_VALUE } from "../src/sandbox-template.ts";

/** Minimal mock provider for testing Sandbox / SandboxTemplate logic. */
function createMockProvider(overrides?: Partial<SandboxProvider>): SandboxProvider {
  let containerRunning = false;

  const base: SandboxProvider = {
    type: "docker",
    async ensureReady() {},
    async run(_options: RunContainerOptions) {
      containerRunning = true;
      return "mock-container-id";
    },
    async start() {},
    async stop() {},
    async restart() {},
    async remove() {},
    async exec(_nameOrId: string, command: string[], _options?: ExecOptions): Promise<ExecResult> {
      return { exitCode: 0, stdout: command.join(" "), stderr: "" };
    },
    spawn(_nameOrId: string, _command: string[], _options?: SpawnOptions): ExecHandle {
      // Tests that need a real handle should override this
      throw new Error("spawn not mocked");
    },
    async logs() {
      return "mock logs";
    },
    logsStream() {
      return new ReadableStream<string>({
        start(controller) {
          controller.close();
        },
      });
    },
    async inspect(nameOrId: string): Promise<ContainerInfo> {
      if (!containerRunning) throw new ContainerNotFoundError(nameOrId, "docker");
      return {
        id: nameOrId,
        name: nameOrId,
        image: "test:latest",
        state: "running",
        ip: "192.168.64.2",
        labels: { [SDK_LABEL]: SDK_LABEL_VALUE },
      };
    },
    async list() {
      return [];
    },
    async pull() {},
    async imageExists() {
      return true;
    },
    async copyTo() {},
    async copyFrom() {},
    async resolveAddress(_nameOrId: string, containerPort: number) {
      return { host: "127.0.0.1", port: containerPort };
    },
  };
  return { ...base, ...overrides };
}

describe("SandboxSpecSchema", () => {
  test("parses a minimal spec", () => {
    const result = SandboxSpecSchema.parse({ name: "test", image: "alpine:latest" });

    expect(result.name).toBe("test");
    expect(result.image).toBe("alpine:latest");
    expect(result.env).toEqual({});
    expect(result.volumes).toEqual([]);
    expect(result.ports).toEqual([]);
    expect(result.labels).toEqual({});
    expect(result.autoRemove).toBe(false);
    expect(result.providerArgs).toEqual([]);
  });

  test("parses a full spec", () => {
    const result = SandboxSpecSchema.parse({
      name: "full-sandbox",
      image: "sandbox-base:latest",
      command: ["/bin/sh"],
      env: { FOO: "bar" },
      user: "1000:1000",
      hostname: "sandbox",
      network: "none",
      volumes: [{ host: "/tmp/src", container: "/workspace" }],
      ports: [{ host: 8080, container: 80 }],
      labels: { app: "demo" },
      resources: { cpus: 2, memory: "1g" },
      workdir: "/workspace",
      autoRemove: true,
      providerArgs: ["--cap-add", "SYS_PTRACE"],
    });

    expect(result.command).toEqual(["/bin/sh"]);
    expect(result.user).toBe("1000:1000");
    expect(result.network).toBe("none");
    expect(result.resources?.cpus).toBe(2);
    expect(result.providerArgs).toEqual(["--cap-add", "SYS_PTRACE"]);
  });

  test("rejects missing required fields", () => {
    expect(() => SandboxSpecSchema.parse({})).toThrow();
    expect(() => SandboxSpecSchema.parse({ name: "test" })).toThrow();
  });

  test("applies defaults for optional fields", () => {
    const result = SandboxSpecSchema.parse({ name: "defaults", image: "alpine" });
    expect(result.ports).toEqual([]);
    expect(result.volumes).toEqual([]);
    expect(result.labels).toEqual({});
    expect(result.env).toEqual({});
    expect(result.autoRemove).toBe(false);
  });

  test("port protocol defaults to tcp", () => {
    const result = SandboxSpecSchema.parse({
      name: "test",
      image: "alpine",
      ports: [{ host: 8080, container: 80 }],
    });
    expect(result.ports[0]?.protocol).toBe("tcp");
  });

  test("volume readonly defaults to false", () => {
    const result = SandboxSpecSchema.parse({
      name: "test",
      image: "alpine",
      volumes: [{ host: "/tmp", container: "/mnt" }],
    });
    expect(result.volumes[0]?.readonly).toBe(false);
  });

  test("rejects invalid container names", () => {
    expect(() => SandboxSpecSchema.parse({ name: "../../evil", image: "alpine" })).toThrow();
  });
});

describe("SandboxTemplate", () => {
  test("construction wraps invalid specs in SandboxError({code:invalid_spec})", () => {
    try {
      // @ts-expect-error intentional bad input
      // eslint-disable-next-line no-new
      new SandboxTemplate({ name: "bad!" }, { provider: createMockProvider() });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxError);
      expect((error as SandboxError).code).toBe("invalid_spec");
    }
  });

  test("create calls ensureReady and run, returns a Sandbox", async () => {
    const calls: string[] = [];
    const mock = createMockProvider({
      async ensureReady() {
        calls.push("ensureReady");
      },
      async run() {
        calls.push("run");
        return "test-id";
      },
      async inspect() {
        throw new ContainerNotFoundError("test", "docker");
      },
    });

    const template = new SandboxTemplate({ name: "test", image: "alpine" }, { provider: mock });
    const sandbox = await template.create();

    expect(sandbox.id).toBe("test-id");
    expect(calls).toEqual(["ensureReady", "run"]);
  });

  test("create auto-generates a unique name using the spec name as prefix", async () => {
    let capturedOptions: RunContainerOptions | undefined;
    const mock = createMockProvider({
      async run(options: RunContainerOptions) {
        capturedOptions = options;
        return "test-id";
      },
      async inspect() {
        throw new ContainerNotFoundError("test", "docker");
      },
    });

    const template = new SandboxTemplate({ name: "myapp", image: "alpine" }, { provider: mock });
    const sandbox = await template.create();

    expect(sandbox.name).toStartWith("myapp-");
    expect(sandbox.name.length).toBeGreaterThan("myapp-".length);
    expect(capturedOptions?.name).toBe(sandbox.name);
  });

  test("create uses exact name when overridden", async () => {
    let capturedOptions: RunContainerOptions | undefined;
    const mock = createMockProvider({
      async run(options: RunContainerOptions) {
        capturedOptions = options;
        return "test-id";
      },
      async inspect() {
        throw new ContainerNotFoundError("test", "docker");
      },
    });

    const template = new SandboxTemplate({ name: "myapp", image: "alpine" }, { provider: mock });
    const sandbox = await template.create({ name: "exact-name" });

    expect(sandbox.name).toBe("exact-name");
    expect(capturedOptions?.name).toBe("exact-name");
  });

  test("create always attaches the SDK baseline label", async () => {
    let capturedOptions: RunContainerOptions | undefined;
    const mock = createMockProvider({
      async run(options: RunContainerOptions) {
        capturedOptions = options;
        return "test-id";
      },
      async inspect() {
        throw new ContainerNotFoundError("test", "docker");
      },
    });

    const template = new SandboxTemplate(
      { name: "test", image: "alpine", labels: { role: "db" } },
      { provider: mock },
    );
    await template.create();

    expect(capturedOptions?.labels).toEqual({ role: "db", [SDK_LABEL]: SDK_LABEL_VALUE });
  });

  test("create cleans up a stopped container with the same name", async () => {
    const calls: string[] = [];
    const mock = createMockProvider({
      async inspect() {
        calls.push("inspect");
        return {
          id: "old-id",
          name: "test",
          image: "alpine",
          state: "stopped" as const,
          labels: {},
        };
      },
      async remove() {
        calls.push("remove");
      },
      async run() {
        calls.push("run");
        return "new-id";
      },
    });

    const template = new SandboxTemplate({ name: "test", image: "alpine" }, { provider: mock });
    await template.create({ name: "test" });

    expect(calls).toContain("inspect");
    expect(calls).toContain("remove");
    expect(calls).toContain("run");
  });

  test("create throws if a container with the same name is already running", async () => {
    const mock = createMockProvider({
      async inspect() {
        return {
          id: "running-id",
          name: "test",
          image: "alpine",
          state: "running" as const,
          labels: {},
        };
      },
    });

    const template = new SandboxTemplate({ name: "test", image: "alpine" }, { provider: mock });
    await expect(template.create({ name: "test" })).rejects.toBeInstanceOf(SandboxError);
  });

  test("create passes providerArgs through as extraArgs", async () => {
    let capturedOptions: RunContainerOptions | undefined;
    const mock = createMockProvider({
      async run(options: RunContainerOptions) {
        capturedOptions = options;
        return "test-id";
      },
      async inspect() {
        throw new ContainerNotFoundError("test", "docker");
      },
    });

    const template = new SandboxTemplate(
      { name: "test", image: "alpine", providerArgs: ["--cpus", "2"] },
      { provider: mock },
    );
    await template.create();

    expect(capturedOptions?.extraArgs).toEqual(["--cpus", "2"]);
  });

  test("create does not mutate the template spec when overrides are applied", async () => {
    const mock = createMockProvider({
      async inspect() {
        throw new ContainerNotFoundError("test", "docker");
      },
    });

    const template = new SandboxTemplate(
      { name: "test", image: "alpine", env: { A: "1" } },
      { provider: mock },
    );

    await template.create({ env: { B: "2" } });
    await template.create({ env: { C: "3" } });

    expect(template.spec.env).toEqual({ A: "1" });
    expect(template.spec.name).toBe("test");
  });

  test("create merges env and appends volumes/ports from overrides", async () => {
    let captured: RunContainerOptions | undefined;
    const mock = createMockProvider({
      async run(options: RunContainerOptions) {
        captured = options;
        return "id";
      },
      async inspect() {
        throw new ContainerNotFoundError("test", "docker");
      },
    });

    const template = new SandboxTemplate(
      {
        name: "t",
        image: "alpine",
        env: { A: "1", B: "2" },
        volumes: [{ host: "/a", container: "/a" }],
        ports: [{ host: 80, container: 80 }],
      },
      { provider: mock },
    );
    await template.create({
      env: { B: "overridden", C: "3" },
      volumes: [{ host: "/b", container: "/b", readonly: true }],
      ports: [{ host: 81, container: 81 }],
    });

    expect(captured?.env).toMatchObject({ A: "1", B: "overridden", C: "3" });
    expect(captured?.volumes).toHaveLength(2);
    expect(captured?.ports).toHaveLength(2);
  });
});

describe("SandboxTemplate.attach", () => {
  test("attaches to an existing container", async () => {
    const mock = createMockProvider({
      async inspect(nameOrId: string) {
        return {
          id: "abc123",
          name: nameOrId,
          image: "alpine",
          state: "running" as const,
          ip: "192.168.64.5",
          labels: { [SDK_LABEL]: SDK_LABEL_VALUE },
        };
      },
    });

    const template = new SandboxTemplate({ name: "test", image: "alpine" }, { provider: mock });
    const sandbox = await template.attach("my-container");

    expect(sandbox.id).toBe("abc123");
    expect(sandbox.name).toBe("my-container");
  });

  test("throws when the container does not exist", async () => {
    const mock = createMockProvider({
      async inspect(nameOrId: string) {
        throw new ContainerNotFoundError(nameOrId, "docker");
      },
    });

    const template = new SandboxTemplate({ name: "test", image: "alpine" }, { provider: mock });
    await expect(template.attach("nonexistent")).rejects.toBeInstanceOf(ContainerNotFoundError);
  });
});

describe("SandboxTemplate.find", () => {
  test("filters by SDK baseline label and user labels", async () => {
    let capturedFilter: ListFilter | undefined;
    const mock = createMockProvider({
      async list(opts) {
        capturedFilter = opts?.filter;
        return [
          {
            id: "c1",
            name: "app-1",
            image: "alpine",
            state: "running" as const,
            labels: { [SDK_LABEL]: SDK_LABEL_VALUE, role: "worker" },
          },
        ];
      },
    });

    const template = new SandboxTemplate({ name: "app", image: "alpine" }, { provider: mock });
    const sandboxes = await template.find({ label: { role: "worker" } });

    expect(capturedFilter?.labels).toEqual({ role: "worker", [SDK_LABEL]: SDK_LABEL_VALUE });
    expect(sandboxes).toHaveLength(1);
    expect(sandboxes[0]?.id).toBe("c1");
  });

  test("with no filter, still restricts to SDK-managed containers", async () => {
    let capturedFilter: ListFilter | undefined;
    const mock = createMockProvider({
      async list(opts) {
        capturedFilter = opts?.filter;
        return [];
      },
    });

    const template = new SandboxTemplate({ name: "app", image: "alpine" }, { provider: mock });
    await template.find();

    expect(capturedFilter?.labels).toEqual({ [SDK_LABEL]: SDK_LABEL_VALUE });
  });
});

describe("Sandbox instance", () => {
  test("exec delegates to the provider", async () => {
    const mock = createMockProvider({
      async inspect() {
        throw new ContainerNotFoundError("test", "docker");
      },
    });

    const template = new SandboxTemplate({ name: "test", image: "alpine" }, { provider: mock });
    const sandbox = await template.create();

    const result = await sandbox.exec(["echo", "hello"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("echo hello");
  });

  test("address delegates to resolveAddress", async () => {
    const mock = createMockProvider({
      async resolveAddress(_nameOrId: string, containerPort: number) {
        return { host: "192.168.64.5", port: containerPort };
      },
      async inspect() {
        throw new ContainerNotFoundError("test", "docker");
      },
    });

    const template = new SandboxTemplate({ name: "test", image: "alpine" }, { provider: mock });
    const sandbox = await template.create();

    const addr = await sandbox.address(7433);
    expect(addr).toEqual({ host: "192.168.64.5", port: 7433 });
  });

  test("ip() pulls from inspect() and returns null when missing", async () => {
    let inspectCalls = 0;
    const mock = createMockProvider({
      async inspect(nameOrId: string) {
        inspectCalls++;
        const ip = inspectCalls === 1 ? "10.0.0.5" : null;
        return {
          id: nameOrId,
          name: nameOrId,
          image: "alpine",
          state: "running" as const,
          ip,
          labels: {},
        };
      },
    });

    const { Sandbox } = await import("../src/sandbox.ts");
    const direct = new Sandbox("direct-id", "direct", mock);
    expect(await direct.ip()).toBe("10.0.0.5");
    expect(await direct.ip()).toBeNull();
  });

  test("isRunning reflects inspect.state", async () => {
    const mock = createMockProvider({
      async inspect(nameOrId: string) {
        return {
          id: nameOrId,
          name: nameOrId,
          image: "alpine",
          state: "stopped" as const,
          labels: {},
        };
      },
    });
    const { Sandbox } = await import("../src/sandbox.ts");
    const sandbox = new Sandbox("id", "name", mock);
    expect(await sandbox.isRunning()).toBe(false);
  });

  test("destroy stops and removes the container", async () => {
    const calls: string[] = [];
    const mock = createMockProvider({
      async stop() {
        calls.push("stop");
      },
      async remove() {
        calls.push("remove");
      },
      async inspect() {
        throw new ContainerNotFoundError("test", "docker");
      },
    });

    const template = new SandboxTemplate({ name: "test", image: "alpine" }, { provider: mock });
    const sandbox = await template.create();
    const savedId = sandbox.id;
    await sandbox.destroy();

    expect(calls).toContain("stop");
    expect(calls).toContain("remove");
    // id stays populated for logging
    expect(sandbox.id).toBe(savedId);
  });

  test("destroy is idempotent", async () => {
    let removeCalls = 0;
    const mock = createMockProvider({
      async remove() {
        removeCalls++;
      },
      async inspect() {
        throw new ContainerNotFoundError("test", "docker");
      },
    });

    const template = new SandboxTemplate({ name: "test", image: "alpine" }, { provider: mock });
    const sandbox = await template.create();
    await sandbox.destroy();
    await sandbox.destroy();

    expect(removeCalls).toBe(1);
  });

  test("methods throw with code 'destroyed' after destroy", async () => {
    const mock = createMockProvider({
      async inspect() {
        throw new ContainerNotFoundError("test", "docker");
      },
    });

    const template = new SandboxTemplate({ name: "test", image: "alpine" }, { provider: mock });
    const sandbox = await template.create();
    await sandbox.destroy();

    try {
      await sandbox.exec(["echo"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxError);
      expect((error as SandboxError).code).toBe("destroyed");
    }
  });
});
