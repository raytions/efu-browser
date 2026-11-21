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
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(r);
          }),
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
    assert.equal(listBody.allowManage, false);
    assert.equal(listBody.tasks.length, 1);

    // Authorized task metadata is returned for UI display, while internal boundary/system paths are not exposed
    const task0 = listBody.tasks[0];
    assert.equal(task0.root, rootDir);
    assert.deepEqual(task0.excludes, [".snapshot"]);
    assert.equal(task0.outputName, "projects.efu");
    assert.equal(task0.indexUrl, "/indexes/projects.efu");
    assert.equal("allowedRoot" in task0, false);
    assert.equal("mountPoint" in task0, false);
    assert.equal("outputPath" in task0, false);

    // SCANS_ALLOW_MANAGE=false MUST return 403 on backend for POST/PATCH/DELETE
    const createDenied = await fetch(`${srv.origin}/api/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test", root: rootDir, outputName: "test.efu" }),
    });
    assert.equal(createDenied.status, 403);

    const patchDenied = await fetch(`${srv.origin}/api/scans/projects`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    assert.equal(patchDenied.status, 403);

    const delDenied = await fetch(`${srv.origin}/api/scans/projects`, { method: "DELETE" });
    assert.equal(delDenied.status, 403);

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

test("Scans API preserves old EFU byte-for-byte on real gdu read_error (unreadable subdir, non-root) and on interrupted scan (SIGTERM)", { skip: !GDU_BIN }, async () => {
  assert.notEqual(process.getuid(), 0, "Permission error test must NOT run as root");

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-api-fail-"));
  const allowedRoot = path.join(workDir, "nas");
  const rootDir = path.join(allowedRoot, "projects");
  const unreadableDir = path.join(rootDir, "locked-secret");
  const indexDir = path.join(workDir, "indexes");
  const outFile = path.join(indexDir, "projects.efu");
  fs.mkdirSync(unreadableDir, { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "good.txt"), "good");
  fs.writeFileSync(path.join(unreadableDir, "hidden.txt"), "secret");

  // 1. Run a real successful scan first to produce a baseline snapshot
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
        excludes: [],
        exportPrefix: "\\\\nas\\projects",
        outputName: "projects.efu",
        enabled: true,
      },
    ],
  });

  const srv = await listenServer(createScansHttpServer(manager));
  try {
    const okRun = await fetch(`${srv.origin}/api/scans/projects/run`, { method: "POST" });
    assert.equal(okRun.status, 202);
    await manager.waitForIdle(10000);

    const okStatus = await (await fetch(`${srv.origin}/api/scans/projects/status`)).json();
    assert.equal(okStatus.task.status, "succeeded");
    assert.equal(okStatus.task.entryCount, 2);
    const baselineHash = sha256File(outFile);
    const baselineSuccessAt = okStatus.task.lastSuccessAt;

    // 2. Make subdirectory unreadable -> real gdu emits read_error=true -> API marks failed & preserves old EFU
    fs.chmodSync(unreadableDir, 0o000);
    const errRun = await fetch(`${srv.origin}/api/scans/projects/run`, { method: "POST" });
    assert.equal(errRun.status, 202);
    await manager.waitForIdle(10000);

    assert.equal(sha256File(outFile), baselineHash, "Old EFU must remain byte-for-byte identical on real gdu read_error");
    const errStatus = await (await fetch(`${srv.origin}/api/scans/projects/status`)).json();
    assert.equal(errStatus.task.status, "failed");
    assert.match(errStatus.task.errorSummary, /不可读目录|读取错误/);
    assert.ok(!errStatus.task.errorSummary.includes(unreadableDir), "Error summary must not leak internal path");
    assert.equal(errStatus.task.lastSuccessAt, baselineSuccessAt);
    assert.equal(errStatus.task.entryCount, 2);
    fs.chmodSync(unreadableDir, 0o755);

    // 3. Interrupted scan (SIGTERM via shutdown/signal) -> preserves old EFU and reports interruption
    const hangCli = path.join(workDir, "hang-cli.mjs");
    fs.writeFileSync(hangCli, "setInterval(() => {}, 1000);\n", "utf8");
    const manager2 = createScansManager({
      indexDir,
      allowTrigger: true,
      cliScriptPath: hangCli,
      logger: { log() {}, warn() {}, error() {} },
      tasks: [
        {
          id: "projects",
          name: "NAS 项目目录",
          root: rootDir,
          allowedRoot,
          mountPoint: null,
          excludes: [],
          exportPrefix: null,
          outputName: "projects.efu",
          enabled: true,
        },
      ],
    });
    const trig = manager2.triggerScan("projects");
    assert.equal(trig.ok, true);
    await new Promise((r) => setTimeout(r, 60));
    manager2.shutdown();
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(sha256File(outFile), baselineHash, "Old EFU must remain byte-for-byte identical on interrupted scan");
    const intrTask = manager2.getPublicTask("projects");
    assert.equal(intrTask.status, "failed");
    assert.match(intrTask.errorSummary, /意外中断/);
  } finally {
    try {
      fs.chmodSync(unreadableDir, 0o755);
    } catch {
      // ignore
    }
    manager.shutdown();
    await srv.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("sanitizeScanError masks internal stderr and paths", () => {
  const err = sanitizeScanError("open /mnt/secret/dir: permission denied", 1);
  assert.ok(!err.includes("/mnt/secret/dir"));
  assert.match(err, /不可读目录|读取错误/);
  assert.match(sanitizeScanError("", null, "SIGTERM"), /意外中断/);
});

test("GET /api/scan-roots and /api/scan-roots/:rootId/entries list immediate subdirectories only and block traversal/symlink escapes", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-roots-api-"));
  const nasRoot = path.join(workDir, "nas");
  const dataRoot = path.join(workDir, "data");
  const outsideSecret = path.join(workDir, "secret-outside");
  const indexDir = path.join(workDir, "indexes");

  fs.mkdirSync(path.join(nasRoot, "research", "slides"), { recursive: true });
  fs.mkdirSync(path.join(nasRoot, "archive"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "lab-a"), { recursive: true });
  fs.mkdirSync(outsideSecret, { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });

  // Regular file that must NOT appear in directory listing
  fs.writeFileSync(path.join(nasRoot, "secret-file.txt"), "do-not-read-contents");
  fs.writeFileSync(path.join(nasRoot, "research", "nested-file.svs"), "binary");

  // Symlink escaping allowedRoot (must be hidden and blocked)
  fs.symlinkSync(outsideSecret, path.join(nasRoot, "escape-link"));
  // Symlink staying inside allowedRoot (safe to display)
  fs.symlinkSync(path.join(nasRoot, "archive"), path.join(nasRoot, "safe-link"));

  const manager = createScansManager({
    indexDir,
    allowedRoots: [nasRoot, dataRoot],
    allowManage: true,
    tasks: [],
  });

  const srv = await listenServer(createScansHttpServer(manager));
  try {
    // 1. GET /api/scan-roots
    const rootsRes = await fetch(`${srv.origin}/api/scan-roots`);
    assert.equal(rootsRes.status, 200);
    const rootsBody = await rootsRes.json();
    assert.equal(rootsBody.mode, "real");
    assert.equal(rootsBody.roots.length, 2);
    const nasId = rootsBody.roots[0].id;
    assert.equal(rootsBody.roots[0].path, nasRoot);

    // 2. Top-level entries under nasRoot: immediate subdirs only, no files, no escape symlink
    const topRes = await fetch(`${srv.origin}/api/scan-roots/${encodeURIComponent(nasId)}/entries`);
    assert.equal(topRes.status, 200);
    const topBody = await topRes.json();
    assert.equal(topBody.currentPath, nasRoot);
    assert.equal(topBody.relativePath, "");
    assert.equal(topBody.parentRelativePath, null);
    const topNames = topBody.entries.map((e) => e.name);
    assert.deepEqual(topNames, ["archive", "research", "safe-link"]);
    assert.ok(!topNames.includes("secret-file.txt"));
    assert.ok(!topNames.includes("escape-link"));

    // 3. Step into research -> shows slides only (not nested-file.svs), parentRelativePath is ""
    const subRes = await fetch(
      `${srv.origin}/api/scan-roots/${encodeURIComponent(nasId)}/entries?path=research`
    );
    assert.equal(subRes.status, 200);
    const subBody = await subRes.json();
    assert.equal(subBody.currentPath, path.join(nasRoot, "research"));
    assert.equal(subBody.relativePath, "research");
    assert.equal(subBody.parentRelativePath, "");
    assert.deepEqual(
      subBody.entries.map((e) => e.name),
      ["slides"]
    );

    // 4. Reject arbitrary absolute path
    const absRes = await fetch(
      `${srv.origin}/api/scan-roots/${encodeURIComponent(nasId)}/entries?path=/etc`
    );
    assert.equal(absRes.status, 400);

    // 5. Reject path traversal
    const travRes = await fetch(
      `${srv.origin}/api/scan-roots/${encodeURIComponent(nasId)}/entries?path=../secret-outside`
    );
    assert.equal(travRes.status, 400);

    // 6. Reject direct traversal into symlink escaping allowedRoot
    const escRes = await fetch(
      `${srv.origin}/api/scan-roots/${encodeURIComponent(nasId)}/entries?path=escape-link`
    );
    assert.equal(escRes.status, 403);

    // 7. Unknown rootId returns 404
    const missingRes = await fetch(`${srv.origin}/api/scan-roots/nonexistent/entries`);
    assert.equal(missingRes.status, 404);
  } finally {
    manager.shutdown();
    await srv.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("POST/PATCH/DELETE /api/scans validates boundaries, persists scans.json, runs gdu, and preserves historical EFU on delete", { skip: !GDU_BIN }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-crud-api-"));
  const nasRoot = path.join(workDir, "nas");
  const slidesDir = path.join(nasRoot, "slides");
  const outsideDir = path.join(workDir, "outside");
  const indexDir = path.join(workDir, "indexes");
  const tasksFile = path.join(workDir, "config", "scans.json");

  fs.mkdirSync(path.join(slidesDir, "batch-1"), { recursive: true });
  fs.mkdirSync(path.join(slidesDir, ".snapshot"), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(slidesDir, "batch-1", "sample-01.svs"), "slide-bytes");
  fs.writeFileSync(path.join(slidesDir, ".snapshot", "ignored.svs"), "ignore-me");
  fs.symlinkSync(outsideDir, path.join(nasRoot, "bad-link"));

  const manager = createScansManager({
    tasksFile,
    indexDir,
    allowedRoots: [nasRoot],
    allowTrigger: true,
    allowManage: true,
    gduBin: GDU_BIN,
    logger: { log() {}, warn() {}, error() {} },
  });

  const srv = await listenServer(createScansHttpServer(manager));
  try {
    // Reject path outside allowedRoots
    const badRoot = await fetch(`${srv.origin}/api/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad", root: outsideDir, outputName: "bad.efu" }),
    });
    assert.equal(badRoot.status, 400);

    // Reject symlink escaping allowedRoots
    const badLink = await fetch(`${srv.origin}/api/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Escape",
        root: path.join(nasRoot, "bad-link"),
        outputName: "escape.efu",
      }),
    });
    assert.equal(badLink.status, 400);

    // Reject unsafe outputName
    const badOut = await fetch(`${srv.origin}/api/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "BadOut",
        root: slidesDir,
        outputName: "../evil.efu",
      }),
    });
    assert.equal(badOut.status, 400);

    // Create valid task via POST /api/scans
    const createdRes = await fetch(`${srv.origin}/api/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "科研切片",
        root: slidesDir,
        excludes: [".snapshot", "@eaDir"],
        exportPrefix: "\\\\nas\\slides",
        outputName: "slides.efu",
      }),
    });
    assert.equal(createdRes.status, 201);
    const createdBody = await createdRes.json();
    assert.equal(createdBody.task.id, "slides");
    assert.equal(createdBody.task.root, slidesDir);
    assert.deepEqual(createdBody.task.excludes, [".snapshot", "@eaDir"]);
    assert.equal(createdBody.task.indexUrl, "/indexes/slides.efu");

    // Verify atomic persistence to tasksFile with authoritative allowedRoots
    const savedConfig = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    assert.deepEqual(savedConfig.allowedRoots, [nasRoot]);
    assert.equal(savedConfig.tasks.length, 1);
    assert.equal(savedConfig.tasks[0].id, "slides");

    // Duplicate outputName/id returns 409
    const dupRes = await fetch(`${srv.origin}/api/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "重复任务",
        root: slidesDir,
        outputName: "slides.efu",
      }),
    });
    assert.equal(dupRes.status, 409);

    // PATCH task name & exportPrefix
    const patchRes = await fetch(`${srv.origin}/api/scans/slides`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "科研切片归档", exportPrefix: "\\\\nas\\lab-slides" }),
    });
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.json();
    assert.equal(patchBody.task.name, "科研切片归档");
    assert.equal(patchBody.task.exportPrefix, "\\\\nas\\lab-slides");

    // Trigger real gdu scan on the newly created task
    const runRes = await fetch(`${srv.origin}/api/scans/slides/run`, { method: "POST" });
    assert.equal(runRes.status, 202);
    await manager.waitForIdle(10000);

    const statusBody = await (await fetch(`${srv.origin}/api/scans/slides/status`)).json();
    assert.equal(statusBody.task.status, "succeeded");
    assert.equal(statusBody.task.entryCount, 1);
    const efuPath = path.join(indexDir, "slides.efu");
    assert.equal(fs.existsSync(efuPath), true);
    const efuText = fs.readFileSync(efuPath, "utf8");
    assert.match(efuText, /\\\\nas\\lab-slides\\batch-1\\sample-01\.svs,11,/);
    assert.ok(!efuText.includes("ignored.svs"));

    // DELETE task definition preserves historical EFU file on disk
    const delRes = await fetch(`${srv.origin}/api/scans/slides`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    const afterDelList = await (await fetch(`${srv.origin}/api/scans`)).json();
    assert.equal(afterDelList.tasks.length, 0);
    assert.equal(fs.existsSync(efuPath), true, "DELETE must NOT delete historical EFU snapshot");
  } finally {
    manager.shutdown();
    await srv.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
