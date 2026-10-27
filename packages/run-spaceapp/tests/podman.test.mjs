import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import {
  composeCommand,
  createDefaultConfig,
  loadConfig,
  podmanUnshareChownArgs,
  prepareInstallation,
  resolveContainerEngine,
  saveConfig,
  validateConfig
} from "../src/index.mjs";
import {
  detectContainerEngine,
  ensureDockerAvailable,
  podmanCliAndComposeAreAvailable,
  podmanIsReady
} from "../src/prerequisites.mjs";
import { inspectStoragePlan } from "../src/storage.mjs";
import { run } from "../src/cli.mjs";

function capture() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    }
  });
  return { stream, value: () => value };
}

test("resolveContainerEngine and validateConfig support docker and podman", () => {
  assert.equal(resolveContainerEngine(undefined, "docker"), "docker");
  assert.equal(resolveContainerEngine("auto", "podman"), "podman");
  assert.equal(resolveContainerEngine("podman", "docker"), "podman");
  assert.equal(resolveContainerEngine("docker", "podman"), "docker");
  assert.throws(() => resolveContainerEngine("containerd"), /auto, docker, or podman/i);

  const podmanConfig = createDefaultConfig({
    version: "1.1.8",
    profile: "small",
    containerEngine: "podman"
  });
  assert.equal(podmanConfig.containerEngine, "podman");
  assert.equal(validateConfig(podmanConfig).containerEngine, "podman");
  assert.throws(
    () => validateConfig({ ...podmanConfig, containerEngine: "rkt" }),
    /containerEngine must be docker or podman/i
  );
});

test("composeCommand uses podman compose when containerEngine or engine is podman", () => {
  const home = resolve(tmpdir(), "spaceapp-podman-home");
  const up = composeCommand("up", home, {
    profile: "small",
    containerEngine: "podman"
  });
  assert.equal(up.command, "podman");
  assert.deepEqual(up.args.slice(0, 3), ["compose", "--project-name", up.args[2]]);
  assert.deepEqual(up.args.slice(-3), ["up", "-d", "--remove-orphans"]);

  const status = composeCommand("status", home, {
    profile: "small",
    engine: "podman"
  });
  assert.equal(status.command, "podman");
  assert.equal(status.args.at(-1), "ps");

  const down = composeCommand("down", home, {
    profile: "small",
    containerEngine: "podman"
  });
  assert.equal(down.command, "podman");
  assert.equal(down.args.at(-1), "down");

  assert.throws(
    () => composeCommand("up", home, { engine: "invalid" }),
    /Unsupported container engine/i
  );
});

test("detectContainerEngine falls back to rootless Podman when Docker is absent", async () => {
  const podmanOnlyExecute = async (spec) => {
    if (spec.command === "docker") return 127;
    if (spec.command === "podman") return 0;
    return 127;
  };
  assert.equal(await podmanCliAndComposeAreAvailable(podmanOnlyExecute), true);
  assert.equal(await podmanIsReady(podmanOnlyExecute), true);
  assert.equal(
    await detectContainerEngine({ execute: podmanOnlyExecute, env: {} }),
    "podman"
  );

  const dockerAndPodmanExecute = async (spec) => {
    if (spec.command === "docker" || spec.command === "podman") return 0;
    return 127;
  };
  assert.equal(
    await detectContainerEngine({ execute: dockerAndPodmanExecute, env: {} }),
    "docker"
  );
  assert.equal(
    await detectContainerEngine({
      execute: dockerAndPodmanExecute,
      env: { SPACEAPP_CONTAINER_ENGINE: "podman" }
    }),
    "podman"
  );
});

test("ensureDockerAvailable verifies rootless Podman readiness when podman is requested", async () => {
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const result = await ensureDockerAvailable({
    platform: "linux",
    arch: "x64",
    env: { SPACEAPP_CONTAINER_ENGINE: "podman" },
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec) => {
      calls.push(`${spec.command} ${spec.args.join(" ")}`);
      return spec.command === "podman" ? 0 : 127;
    }
  });
  assert.deepEqual(result, { code: 0, reexecuted: false });
  assert.deepEqual(calls, [
    "podman --version",
    "podman compose version",
    "podman info"
  ]);
  assert.match(stdout.value(), /Rootless Podman engine is ready/i);
  assert.equal(stderr.value(), "");
});

test("podmanUnshareChownArgs builds rootless UID mapping arguments without shell execution", () => {
  const home = resolve(tmpdir(), "spaceapp-workspace");
  assert.deepEqual(podmanUnshareChownArgs(home), [
    "unshare",
    "chown",
    "-R",
    "10001:10001",
    home
  ]);
  assert.throws(() => podmanUnshareChownArgs("relative/path"), /must be absolute/i);
});

test("inspectStoragePlan reads rootless Podman host info and graphRoot", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-storage-"));
  try {
    const { config } = await prepareInstallation(root, {
      version: "1.1.8",
      profile: "small",
      containerEngine: "podman"
    });
    const commands = [];
    const plan = await inspectStoragePlan({
      root,
      config,
      existingConfig: null,
      resources: {
        cpuCount: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        freeDiskBytes: 50 * 1024 ** 3
      },
      operation: "fresh",
      execute: async (spec, io) => {
        commands.push(spec.command);
        if (spec.command === "podman" && spec.args[0] === "info") {
          io.stdout?.write(JSON.stringify({
            host: {
              arch: "amd64",
              cpus: 6,
              memTotal: 12 * 1024 ** 3,
              security: { rootless: true }
            },
            store: { graphRoot: root }
          }));
          return 0;
        }
        if (spec.command === "podman" && spec.args[0] === "image") {
          io.stdout?.write("sha256:" + "a".repeat(64) + "\n");
          return 0;
        }
        return 1;
      }
    });
    assert.ok(commands.every((cmd) => cmd === "podman"));
    assert.equal(plan.resources.engineCpuCount, 6);
    assert.equal(plan.resources.engineMemoryBytes, 12 * 1024 ** 3);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI lifecycle (up -> status -> down) executes podman compose when configured for Podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-cli-"));
  try {
    const { config } = await prepareInstallation(root, {
      version: "1.1.8",
      profile: "small",
      containerEngine: "podman"
    });
    await saveConfig(root, config);
    const loaded = await loadConfig(root);
    assert.equal(loaded.containerEngine, "podman");

    const executed = [];
    for (const cmd of ["up", "status", "down"]) {
      const stdout = capture();
      const stderr = capture();
      const code = await run([cmd], {
        env: { SPACEAPP_HOME: root, SPACEAPP_IMAGE_VERIFY: "off" },
        platform: "linux",
        stdout: stdout.stream,
        stderr: stderr.stream,
        stdin: Readable.from([]),
        execute: async (spec) => {
          executed.push({ command: spec.command, action: spec.args.at(-1) });
          return 0;
        }
      });
      assert.equal(code, 0);
    }
    assert.deepEqual(executed, [
      { command: "podman", action: "--remove-orphans" },
      { command: "podman", action: "ps" },
      { command: "podman", action: "down" }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
