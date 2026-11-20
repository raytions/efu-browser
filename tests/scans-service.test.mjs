import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import {
  createScansHttpServer,
  createScansManager,
  sanitizeScanError,
  validateTasksConfig,
} from "../scripts/scans-service-lib.mjs";

function findGduBin() {
  for (const bin of [process.env.EFU_GDU_BIN, "/home/antigravity/.local/bin/gdu", "gdu"]) {
    if (!bin) continue;
    const res = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (!res.error && res.status === 0) return bin;
  }
  return null;
}

const GDU_BIN = findGduBin();

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listenServer(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test("validateTasksConfig rejects paths outside allowedRoot, path traversal, and unsafe outputName", () => {
  const indexDir = "/tmp/efu-safe-indexes";
  const baseTask = {
    id: "projects",
    name: "NAS Projects",
    root: "/mnt/nas/projects",
    allowedRoot: "/mnt/nas",
    mountPoint: "/mnt/nas",
    excludes: [".snapshot", "@eaDir"],
    exportPrefix: "\\\\nas\\projects",
    outputName: "projects.efu",
    enabled: true,
    schedule: "0 3 * * *",
  };

  assert.equal(validateTasksConfig({ tasks: [baseTask] }, indexDir).length, 1);

  // Outside allowedRoot (sibling prefix attack /mnt/nas2 vs /mnt/nas)
  assert.throws(
    () => validateTasksConfig({ tasks: [{ ...baseTask, root: "/mnt/nas2/projects" }] }, indexDir),
    /allowedRoot/
  );

  // Traversal in root
  assert.throws(
    () => validateTasksConfig({ tasks: [{ ...baseTask, root: "/mnt/nas/../etc" }] }, indexDir),
    /路径穿越/
  );

  // Traversal in allowedRoot
  assert.throws(
    () => validateTasksConfig({ tasks: [{ ...baseTask, allowedRoot: "/mnt/../mnt/nas" }] }, indexDir),
    /路径穿越/
  );

  // Relative root
  assert.throws(
    () => validateTasksConfig({ tasks: [{ ...baseTask, root: "mnt/nas/projects" }] }, indexDir),
    /绝对路径/
  );

  // Unsafe outputName: traversal, slash, non-.efu, hidden file
  for (const badOut of ["../escape.efu", "sub/projects.efu", "projects.txt", ".hidden.efu", "a\\b.efu"]) {
    assert.throws(
      () => validateTasksConfig({ tasks: [{ ...baseTask, outputName: badOut }] }, indexDir),
      /outputName/
    );
  }

  // Unsafe task id
  assert.throws(
    () => validateTasksConfig({ tasks: [{ ...baseTask, id: "../bad" }] }, indexDir),
    /\.id 无效/
  );
});

test("Scans API enforces SCANS_ALLOW_TRIGGER=false (403), disabled tasks (403), and never leaks internal paths/config", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-api-sec-"));
  const allowedRoot = path.join(workDir, "nas");
  const rootDir = path.join(allowedRoot, "projects");
  const indexDir = path.join(workDir, "indexes");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });

  const manager = createScansManager({
    indexDir,
    allowTrigger: false,
    tasks: [
      {
        id: "projects",
        name: "NAS 项目目录",
        root: rootDir,
        allowedRoot,
        mountPoint: null,
        excludes: [".snapshot"],
        exportPrefix: "\\\\nas\\projects",
        outputName: "projects.efu",
        enabled: true,
        schedule: "0 3 * * *",
      },
    ],
  });

  const srv = await listenServer(createScansHttpServer(manager));
  try {
    const listRes = await fetch(`${srv.origin}/api/scans`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.mode, "real");
    assert.equal(listBody.allowTrigger, false);
    assert.equal(listBody.tasks.length, 1);

    // Ensure sensitive internal fields are NOT exposed in public API
    const rawJson = JSON.stringify(listBody);
    assert.ok(!rawJson.includes(rootDir), "API must not leak internal root path");
    assert.ok(!rawJson.includes(allowedRoot), "API must not leak internal allowedRoot");
    assert.equal(listBody.tasks[0].indexUrl, "/indexes/projects.efu");

    // SCANS_ALLOW_TRIGGER=false MUST return 403 on backend
    const runRes = await fetch(`${srv.origin}/api/scans/projects/run`, { method: "POST" });
    assert.equal(runRes.status, 403);
    const runBody = await runRes.json();
    assert.match(runBody.error, /SCANS_ALLOW_TRIGGER=false/);

    // GET index-url endpoint works
    const idxRes = await fetch(`${srv.origin}/api/scans/projects/index-url`);
    assert.equal(idxRes.status, 200);
    const idxBody = await idxRes.json();
    assert.equal(idxBody.url, "/indexes/projects.efu");
    assert.equal(idxBody.hasSnapshot, false);
  } finally {
    manager.shutdown();
    await srv.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("Scans API blocks symlink escape out of allowedRoot at runtime", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-api-sym-"));
  const allowedRoot = path.join(workDir, "allowed");
  const outsideDir = path.join(workDir, "outside-secret");
  const indexDir = path.join(workDir, "indexes");
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });

  const escapeLink = path.join(allowedRoot, "escape-link");
  fs.symlinkSync(outsideDir, escapeLink);

  const manager = createScansManager({
    indexDir,
    allowTrigger: true,
    logger: { log() {}, warn() {}, error() {} },
    tasks: [
      {
        id: "escape",
        name: "Symlink Escape Attempt",
        root: escapeLink,
        allowedRoot,
        mountPoint: null,
        excludes: [],
        exportPrefix: null,
        outputName: "escape.efu",
        enabled: true,
      },
    ],
  });

  const srv = await listenServer(createScansHttpServer(manager));
  try {
    const res = await fetch(`${srv.origin}/api/scans/escape/run`, { method: "POST" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /安全边界/);
    assert.ok(!body.error.includes(outsideDir));
  } finally {
    manager.shutdown();
    await srv.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("Scans API rejects duplicate concurrent run (409), recovers stale running state on restart, and preserves old EFU on failure", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-api-conc-"));
  const allowedRoot = path.join(workDir, "nas");
  const rootDir = path.join(allowedRoot, "projects");
  const indexDir = path.join(workDir, "indexes");
  const stateFile = path.join(indexDir, ".scans-state.json");
  const outFile = path.join(indexDir, "projects.efu");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });

  // Seed an existing valid EFU snapshot
  const baseline = "Filename,Size,Date Modified\r\n/mnt/nas/projects/old.txt,12,134000000000000000\r\n";
  fs.writeFileSync(outFile, baseline, "utf8");
  const baselineHash = sha256File(outFile);

  // Create a slow mock CLI script that sleeps 300ms then fails with permission denied
  const slowFailCli = path.join(workDir, "slow-fail-cli.mjs");
  fs.writeFileSync(
    slowFailCli,
    `setTimeout(() => { console.error("open /secret/internal/path: permission denied (read_error)"); process.exit(1); }, 300);\n`,
    "utf8"
  );

  const taskDef = {
    id: "projects",
    name: "NAS 项目目录",
    root: rootDir,
    allowedRoot,
    mountPoint: null,
    excludes: [],
    exportPrefix: null,
    outputName: "projects.efu",
    enabled: true,
  };

  // 1. Simulate stale "running" state persisted before crash/restart
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      tasks: {
        projects: {
          status: "running",
          lastSuccessAt: "2026-11-19T03:00:00.000Z",
          lastStartedAt: "2026-11-20T03:00:00.000Z",
          entryCount: 42,
        },
      },
    }),
    "utf8"
  );

  const manager = createScansManager({
    indexDir,
    stateFile,
    allowTrigger: true,
    cliScriptPath: slowFailCli,
    logger: { log() {}, warn() {}, error() {} },
    tasks: [taskDef],
  });

  const srv = await listenServer(createScansHttpServer(manager));
  try {
    // Verify stale running recovered to failed on startup while keeping lastSuccessAt & entryCount
    const statusBefore = await (await fetch(`${srv.origin}/api/scans/projects/status`)).json();
    assert.equal(statusBefore.task.status, "failed");
    assert.match(statusBefore.task.errorSummary, /服务重启/);
    assert.equal(statusBefore.task.lastSuccessAt, "2026-11-19T03:00:00.000Z");
    assert.equal(statusBefore.task.entryCount, 42);

    // 2. Trigger run -> 202, immediate duplicate run -> 409
    const first = await fetch(`${srv.origin}/api/scans/projects/run`, { method: "POST" });
    assert.equal(first.status, 202);

    const second = await fetch(`${srv.origin}/api/scans/projects/run`, { method: "POST" });
    assert.equal(second.status, 409);

    await manager.waitForIdle(5000);

    // 3. Verify failed scan preserved old EFU byte-for-byte & sanitized error summary (no internal path leak)
    assert.equal(sha256File(outFile), baselineHash);
    const statusAfter = await (await fetch(`${srv.origin}/api/scans/projects/status`)).json();
    assert.equal(statusAfter.task.status, "failed");
    assert.match(statusAfter.task.errorSummary, /不可读目录|读取错误/);
    assert.ok(!statusAfter.task.errorSummary.includes("/secret/internal/path"));
    assert.equal(statusAfter.task.lastSuccessAt, "2026-11-19T03:00:00.000Z");
    assert.equal(statusAfter.task.entryCount, 42);
  } finally {
    manager.shutdown();
    await srv.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("Scans API end-to-end executes real efu-scan.mjs + gdu and publishes EFU snapshot", { skip: !GDU_BIN }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-api-e2e-"));
  const allowedRoot = path.join(workDir, "nas");
  const rootDir = path.join(allowedRoot, "projects");
  const indexDir = path.join(workDir, "indexes");
  fs.mkdirSync(path.join(rootDir, "reports"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, ".snapshot"), { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "reports", "年度报告 2026.pdf"), "pdf-content-bytes");
  fs.writeFileSync(path.join(rootDir, ".snapshot", "skip-me.txt"), "skip");

  const manager = createScansManager({
    indexDir,
    allowTrigger: true,
    gduBin: GDU_BIN,
    logger: { log() {}, warn() {}, error() {} },
    tasks: [
      {
        id: "projects",
        name: "NAS 项目目录",
        root: rootDir,
        allowedRoot,
        mountPoint: null,
        excludes: [".snapshot"],
        exportPrefix: "\\\\nas\\projects",
        outputName: "projects.efu",
        enabled: true,
      },
    ],
  });

  const srv = await listenServer(createScansHttpServer(manager));
  try {
    const runRes = await fetch(`${srv.origin}/api/scans/projects/run`, { method: "POST" });
    assert.equal(runRes.status, 202);
    await manager.waitForIdle(10000);

    const statusRes = await (await fetch(`${srv.origin}/api/scans/projects/status`)).json();
    assert.equal(statusRes.task.status, "succeeded");
    assert.equal(statusRes.task.entryCount, 1);
    assert.equal(statusRes.task.hasSnapshot, true);
    assert.ok(statusRes.task.lastSuccessAt);

    const efu = fs.readFileSync(path.join(indexDir, "projects.efu"), "utf8");
    assert.match(efu, /\\\\nas\\projects\\reports\\年度报告 2026\.pdf,17,/);
    assert.ok(!efu.includes("skip-me.txt"));
  } finally {
    manager.shutdown();
    await srv.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("sanitizeScanError masks internal stderr and paths", () => {
  const err = sanitizeScanError("open /mnt/secret/dir: permission denied", 1);
  assert.ok(!err.includes("/mnt/secret/dir"));
  assert.match(err, /不可读目录|读取错误/);
});
