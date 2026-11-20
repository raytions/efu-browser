import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const EfuCore = require("../efu-core.js");
const ScansDemoService = require("../scans-demo-service.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = path.resolve(__dirname, "../demo");

test("demo-before.efu and demo-after.efu are valid fictional EFU snapshots with demo-slide-003.svs added", () => {
  const beforeRaw = fs.readFileSync(path.join(DEMO_DIR, "demo-before.efu"), "utf8");
  const afterRaw = fs.readFileSync(path.join(DEMO_DIR, "demo-after.efu"), "utf8");

  const before = EfuCore.parseEfu(beforeRaw);
  const after = EfuCore.parseEfu(afterRaw);

  assert.equal(before.entries.length, 5);
  assert.equal(after.entries.length, 6);

  const beforeNames = new Set(before.entries.map((e) => e.fileName));
  const afterNames = new Set(after.entries.map((e) => e.fileName));

  assert.equal(beforeNames.has("demo-slide-003.svs"), false);
  assert.equal(afterNames.has("demo-slide-003.svs"), true);

  for (const entry of after.entries) {
    assert.ok(entry.path.startsWith("/mnt/example-nas/demo-archive/"));
    assert.ok(entry.sizeBig !== null && entry.sizeBig > 0n);
    assert.ok(entry.modifiedBig !== null);
  }

  const found = EfuCore.filterAndSortEntries(after.entries, { query: "demo-slide-003.svs" });
  assert.equal(found.filtered.length, 1);
  assert.equal(found.filtered[0].fileName, "demo-slide-003.svs");
});

test("ScansDemoService transitions queued -> scanning -> completed and rejects duplicate start while running", async () => {
  const service = ScansDemoService.createDemoScansService({
    queuedMs: 25,
    scanningSteps: [
      { delayMs: 25, progress: 40, message: "模拟阶段 1/2" },
      { delayMs: 25, progress: 85, message: "模拟阶段 2/2" },
    ],
    now: () => new Date(2026, 10, 20, 10, 30, 0),
  });

  try {
    assert.equal(service.isDemo, true);
    assert.equal(service.demoBannerTitle, "演示模式");
    assert.match(service.demoBannerDescription, /不会访问你的设备、服务器或 NAS/);

    const initial = service.getJob("example-nas");
    assert.equal(initial.status, "idle");
    assert.equal(initial.entryCount, 5);
    assert.equal(initial.hasCompletedRun, false);

    const observedStatuses = [];
    service.subscribe((jobs) => {
      observedStatuses.push(jobs[0].status);
    });

    const firstStart = service.startScan("example-nas");
    assert.deepEqual(firstStart, { started: true });
    assert.equal(service.isRunning("example-nas"), true);

    // Duplicate start during queued/scanning must be blocked
    const dupStart = service.startScan("example-nas");
    assert.deepEqual(dupStart, { started: false, reason: "already_running" });

    // Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 160));

    const done = service.getJob("example-nas");
    assert.equal(done.status, "completed");
    assert.equal(done.progress, 100);
    assert.equal(done.entryCount, 6);
    assert.equal(done.hasCompletedRun, true);
    assert.equal(done.runCount, 1);
    assert.match(done.lastSuccessAt, /2026-11-20 10:30:00（模拟）/);

    assert.ok(observedStatuses.includes("queued"));
    assert.ok(observedStatuses.includes("scanning"));
    assert.equal(observedStatuses[observedStatuses.length - 1], "completed");
  } finally {
    service.dispose();
  }
});
