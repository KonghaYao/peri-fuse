import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function findRepoRoot(startDirectory: string): string {
  let directory = startDirectory;
  for (let depth = 0; depth < 6; depth++) {
    if (
      fs.existsSync(path.join(directory, "Dockerfile")) &&
      fs.existsSync(path.join(directory, "docker-compose.yml"))
    ) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not find repository root from ${startDirectory}`);
}

const repoRoot = findRepoRoot(process.cwd());

interface ComposeConfig {
  services: {
    "peri-fuse": {
      environment: Record<string, string>;
      ports: Array<{ published: string; target: number }>;
    };
  };
}

interface ContainerState {
  ExitCode: number;
  Health?: { Status: string };
  Status: string;
}

function commandSucceeds(command: string, args: string[]): boolean {
  return spawnSync(command, args, { encoding: "utf8", stdio: "pipe" }).status === 0;
}

const composeAvailable = commandSucceeds("docker", ["compose", "version"]);
const smokeRequested = process.env.RUN_DOCKER_SMOKE === "1";
const daemonAvailable = smokeRequested && commandSucceeds("docker", ["info"]);

function dockerfileInstructions(contents: string): string[] {
  const instructions: string[] = [];
  let current = "";

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!current && (line === "" || line.startsWith("#"))) continue;

    const continued = line.endsWith("\\");
    current += `${current ? " " : ""}${continued ? line.slice(0, -1).trimEnd() : line}`;
    if (!continued) {
      instructions.push(current);
      current = "";
    }
  }

  return instructions;
}

function loadComposeConfig(port?: string): ComposeConfig {
  const env = { ...process.env };
  if (port === undefined) delete env.LITE_SERVER_PORT;
  else env.LITE_SERVER_PORT = port;

  const result = spawnSync(
    "docker",
    ["compose", "--env-file", "/dev/null", "config", "--format", "json"],
    { cwd: repoRoot, encoding: "utf8", env },
  );
  if (result.status !== 0) {
    throw new Error(`docker compose config failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as ComposeConfig;
}

function assertComposePort(config: ComposeConfig, port: number): void {
  const service = config.services["peri-fuse"];
  expect(service.environment.LITE_SERVER_PORT).toBe(String(port));
  expect(service.ports[0]?.published).toBe(String(port));
  expect(service.ports[0]?.target).toBe(port);
}

function runDocker(args: string[], timeout = 60_000) {
  return spawnSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    timeout,
  });
}

async function waitForHealthy(containerName: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const inspected = runDocker(["inspect", "--format", "{{json .State}}", containerName]);
    if (inspected.status !== 0) {
      throw new Error(`Could not inspect ${containerName}: ${inspected.stderr}`);
    }

    const state = JSON.parse(inspected.stdout) as ContainerState;
    if (state.Health?.Status === "healthy") return;
    if (state.Status === "exited" || state.Health?.Status === "unhealthy") {
      const logs = runDocker(["logs", containerName]);
      throw new Error(`${containerName} stopped before healthy: ${logs.stdout}${logs.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${containerName} did not become healthy within 60 seconds`);
}

async function expectHealthyEndpoint(containerName: string, containerPort: number): Promise<void> {
  await waitForHealthy(containerName);
  const published = runDocker(["port", containerName, `${containerPort}/tcp`]);
  if (published.status !== 0) {
    throw new Error(`Could not resolve published port: ${published.stderr}`);
  }
  const hostPort = published.stdout.trim().match(/:(\d+)$/)?.[1];
  if (!hostPort) throw new Error(`Unexpected docker port output: ${published.stdout}`);

  const response = await fetch(`http://127.0.0.1:${hostPort}/api/public/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ status: "OK" });
}

describe("container port configuration", () => {
  it("defines an executable health command using the production port parser", () => {
    const dockerfile = fs.readFileSync(`${repoRoot}/Dockerfile`, "utf8");
    const healthcheck = dockerfileInstructions(dockerfile).find((line) =>
      line.startsWith("HEALTHCHECK "),
    );
    expect(healthcheck).toBeDefined();

    const commandJson = healthcheck?.match(/\sCMD\s+(\[.*\])$/)?.[1];
    expect(commandJson).toBeDefined();
    const command = JSON.parse(commandJson ?? "[]") as string[];
    expect(command.slice(0, 2)).toEqual(["node", "-e"]);

    const script = command[2] ?? "";
    expect(script).toMatch(/require\('\.\/packages\/server\/dist\/port\.js'\)/);
    expect(script).toMatch(/resolveLiteServerPort\(process\.env\.LITE_SERVER_PORT\)/);
    expect(script.match(/fetch\((.*?)\)\.then/)?.[1]).toBe(
      "'http://127.0.0.1:' + port + '/api/public/health'",
    );
  });

  it.skipIf(!composeAvailable)("resolves matching default compose ports", () => {
    assertComposePort(loadComposeConfig(), 23332);
  });

  it.skipIf(!composeAvailable)("resolves matching custom compose ports", () => {
    assertComposePort(loadComposeConfig("24332"), 24332);
  });

  it.skipIf(!smokeRequested || !daemonAvailable)(
    "builds one image and verifies default, custom, and invalid container ports",
    async () => {
      const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
      const image = `peri-fuse-smoke:${suffix}`;
      const defaultContainer = `peri-fuse-smoke-${suffix}-default`;
      const customContainer = `peri-fuse-smoke-${suffix}-custom`;
      const invalidContainer = `peri-fuse-smoke-${suffix}-invalid`;
      const containers = [defaultContainer, customContainer, invalidContainer];

      try {
        const built = runDocker(["build", "--tag", image, "."], 600_000);
        if (built.status !== 0) throw new Error(`docker build failed: ${built.stderr}`);

        for (const [name, port, customPort] of [
          [defaultContainer, 23332, false],
          [customContainer, 24332, true],
        ] as const) {
          const args = [
            "run",
            "--detach",
            "--name",
            name,
            "--health-interval",
            "1s",
            "--health-timeout",
            "5s",
            "--health-start-period",
            "1s",
            "--health-retries",
            "30",
            "--publish",
            `127.0.0.1::${port}`,
          ];
          if (customPort) args.push("--env", `LITE_SERVER_PORT=${port}`);
          args.push(image);
          const started = runDocker(args);
          if (started.status !== 0) throw new Error(`docker run failed: ${started.stderr}`);
        }

        await Promise.all([
          expectHealthyEndpoint(defaultContainer, 23332),
          expectHealthyEndpoint(customContainer, 24332),
        ]);

        const invalid = runDocker([
          "run",
          "--name",
          invalidContainer,
          "--env",
          "LITE_SERVER_PORT=24332x",
          image,
        ]);
        expect(invalid.status).not.toBe(0);
        const invalidState = runDocker([
          "inspect",
          "--format",
          "{{json .State}}",
          invalidContainer,
        ]);
        const state = JSON.parse(invalidState.stdout) as ContainerState;
        expect(state.ExitCode).not.toBe(0);
      } finally {
        for (const container of containers) {
          runDocker(["rm", "--force", "--volumes", container]);
        }
        runDocker(["image", "rm", "--force", image]);
      }
    },
    900_000,
  );
});
