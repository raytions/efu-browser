(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === "object") {
    root.EfuScansDemoService = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_STEP_DELAYS = {
    queuedMs: 320,
    scanningSteps: [
      { delayMs: 340, progress: 28, message: "模拟阶段 1/3：遍历虚拟目录树..." },
      { delayMs: 380, progress: 67, message: "模拟阶段 2/3：生成模拟 EFU 快照..." },
      { delayMs: 340, progress: 94, message: "模拟阶段 3/3：校验并原子发布模拟快照..." },
    ],
  };

  // 纯前端虚构演示目录树（不会访问任何真实设备、服务器或 NAS）
  const DEMO_ALLOWED_ROOTS = [
    {
      id: "example-nas",
      name: "example-nas",
      path: "/mnt/example-nas",
      tree: {
        "demo-archive": {
          "2025": {
            reports: {},
          },
          "2026": {
            slides: {},
            reports: {},
          },
        },
        datasets: {
          pathology: {},
          radiology: {},
        },
        "shared-docs": {
          manuals: {},
          templates: {},
        },
      },
    },
    {
      id: "example-lab",
      name: "example-lab",
      path: "/data/example-lab",
      tree: {
        projects: {
          alpha: {},
          beta: {},
        },
        exports: {
          "efu-samples": {},
        },
      },
    },
  ];

  const SAFE_OUTPUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.efu$/i;
  const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

  function createDemoScansService(options = {}) {
    const stepDelays = {
      queuedMs:
        typeof options.queuedMs === "number" ? options.queuedMs : DEFAULT_STEP_DELAYS.queuedMs,
      scanningSteps: Array.isArray(options.scanningSteps)
        ? options.scanningSteps
        : DEFAULT_STEP_DELAYS.scanningSteps,
    };

    const nowFn = typeof options.now === "function" ? options.now : () => new Date();

    const jobs = new Map();
    jobs.set("example-nas", {
      id: "example-nas",
      name: "Example NAS",
      rootPath: "/mnt/example-nas/demo-archive",
      root: "/mnt/example-nas/demo-archive",
      excludes: [".snapshot", "@eaDir"],
      exportPrefix: null,
      outputName: "example-nas.efu",
      scheduleLabel: "仅演示（手动模拟）",
      status: "idle", // idle | queued | scanning | completed
      statusMessage: "尚未运行本次模拟扫描（当前展示扫描前虚构基线）",
      progress: 0,
      lastSuccessAt: "2026-11-18 03:00:00（虚构基线）",
      beforeEntryCount: 5,
      afterEntryCount: 6,
      entryCount: 5,
      beforeUrl: "demo/demo-before.efu",
      afterUrl: "demo/demo-after.efu",
      addedFiles: ["demo-slide-003.svs"],
      suggestedSearch: "demo-slide-003.svs",
      hasCompletedRun: false,
      runCount: 0,
    });

    const listeners = new Set();
    const activeTimers = new Set();

    function cloneJob(job) {
      return {
        ...job,
        excludes: Array.isArray(job.excludes) ? [...job.excludes] : [],
        addedFiles: [...job.addedFiles],
      };
    }

    function notify() {
      const snapshot = listJobs();
      listeners.forEach((listener) => {
        try {
          listener(snapshot);
        } catch (error) {
          console.error("Scans listener error:", error);
        }
      });
    }

    function listJobs() {
      return Array.from(jobs.values()).map(cloneJob);
    }

    function getJob(jobId) {
      const job = jobs.get(jobId);
      return job ? cloneJob(job) : null;
    }

    function isRunning(jobId) {
      const job = jobs.get(jobId);
      return Boolean(job && (job.status === "queued" || job.status === "scanning"));
    }

    async function listRoots() {
      return {
        ok: true,
        roots: DEMO_ALLOWED_ROOTS.map((r) => ({
          id: r.id,
          name: r.name,
          path: r.path,
        })),
      };
    }

    async function browseRootEntries(rootId, rawRelativePath = "") {
      const rootDef = DEMO_ALLOWED_ROOTS.find((r) => r.id === rootId);
      if (!rootDef) {
        return { ok: false, statusCode: 404, error: "未找到指定的虚构演示根目录" };
      }

      const rel = String(rawRelativePath || "").trim();
      if (rel.startsWith("/") || rel.includes("\\") || rel.includes("..")) {
        return { ok: false, statusCode: 400, error: "无效的演示相对路径" };
      }

      const segments = rel ? rel.split("/").filter(Boolean) : [];
      let cursor = rootDef.tree;
      for (const seg of segments) {
        if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, seg)) {
          return { ok: false, statusCode: 404, error: "虚构演示目录不存在" };
        }
        cursor = cursor[seg];
      }

      const currentPath =
        segments.length > 0 ? `${rootDef.path}/${segments.join("/")}` : rootDef.path;
      const entries = Object.keys(cursor || {})
        .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }))
        .map((name) => {
          const entryRel = segments.length > 0 ? `${segments.join("/")}/${name}` : name;
          return {
            name,
            relativePath: entryRel,
            path: `${currentPath}/${name}`,
          };
        });

      return {
        ok: true,
        data: {
          rootId: rootDef.id,
          rootName: rootDef.name,
          rootPath: rootDef.path,
          currentPath,
          relativePath: segments.join("/"),
          parentRelativePath: segments.length === 0 ? null : segments.slice(0, -1).join("/"),
          entries,
        },
      };
    }

    async function createTask(payload = {}) {
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      if (!name) {
        return { ok: false, statusCode: 400, error: "任务名称不能为空" };
      }

      const root = typeof payload.root === "string" ? payload.root.trim().replace(/\/+$/, "") : "";
      const matchedRoot = DEMO_ALLOWED_ROOTS.find(
        (r) => root === r.path || root.startsWith(`${r.path}/`)
      );
      if (!matchedRoot) {
        return { ok: false, statusCode: 400, error: "请选择虚构演示根目录下的路径" };
      }

      let outputName = typeof payload.outputName === "string" ? payload.outputName.trim() : "";
      if (!outputName && typeof payload.id === "string" && SAFE_ID_RE.test(payload.id.trim())) {
        outputName = `${payload.id.trim()}.efu`;
      }
      if (!SAFE_OUTPUT_NAME_RE.test(outputName) || outputName.includes("..")) {
        return { ok: false, statusCode: 400, error: "EFU 文件名无效：仅允许字母数字/._- 且以 .efu 结尾" };
      }

      const id =
        typeof payload.id === "string" && payload.id.trim()
          ? payload.id.trim()
          : outputName.replace(/\.efu$/i, "");
      if (!SAFE_ID_RE.test(id)) {
        return { ok: false, statusCode: 400, error: "任务标识无效" };
      }
      if (jobs.has(id)) {
        return { ok: false, statusCode: 409, error: `演示任务标识 "${id}" 已存在` };
      }
      for (const existing of jobs.values()) {
        if (existing.outputName === outputName) {
          return { ok: false, statusCode: 409, error: `演示输出名 "${outputName}" 已被其他任务使用` };
        }
      }

      const excludes = Array.isArray(payload.excludes)
        ? payload.excludes.map((s) => String(s || "").trim()).filter(Boolean)
        : [];
      const exportPrefix =
        typeof payload.exportPrefix === "string" && payload.exportPrefix.trim()
          ? payload.exportPrefix.trim()
          : null;

      const newJob = {
        id,
        name,
        rootPath: root,
        root,
        excludes,
        exportPrefix,
        outputName,
        scheduleLabel: "仅演示（手动模拟）",
        status: "idle",
        statusMessage: "尚未运行本次模拟扫描（本地虚构任务，不访问真实文件系统）",
        progress: 0,
        lastSuccessAt: "尚未扫描（虚构任务）",
        beforeEntryCount: 5,
        afterEntryCount: 6,
        entryCount: 5,
        beforeUrl: "demo/demo-before.efu",
        afterUrl: "demo/demo-after.efu",
        addedFiles: ["demo-slide-003.svs"],
        suggestedSearch: "demo-slide-003.svs",
        hasCompletedRun: false,
        runCount: 0,
      };

      jobs.set(id, newJob);
      notify();
      return { ok: true, statusCode: 201, task: cloneJob(newJob) };
    }

    async function deleteTask(jobId) {
      const existing = jobs.get(jobId);
      if (!existing) {
        return { ok: false, statusCode: 404, error: "未找到指定的演示任务" };
      }
      if (existing.status === "queued" || existing.status === "scanning") {
        return { ok: false, statusCode: 409, error: "演示任务正在运行中，暂不可删除" };
      }
      jobs.delete(jobId);
      notify();
      return { ok: true, statusCode: 200, id: jobId };
    }

    function formatSimulatedTimestamp(date) {
      const pad = (n) => String(n).padStart(2, "0");
      return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}（模拟）`
      );
    }

    function schedule(fn, delayMs) {
      const timer = setTimeout(() => {
        activeTimers.delete(timer);
        fn();
      }, delayMs);
      activeTimers.add(timer);
      return timer;
    }

    function startScan(jobId) {
      const job = jobs.get(jobId);
      if (!job) {
        return { started: false, reason: "not_found" };
      }
      if (job.status === "queued" || job.status === "scanning") {
        return { started: false, reason: "already_running" };
      }

      job.status = "queued";
      job.progress = 8;
      job.statusMessage = "模拟状态：等待队列调度...";
      notify();

      let elapsed = stepDelays.queuedMs;

      stepDelays.scanningSteps.forEach((step) => {
        const triggerAt = elapsed;
        schedule(() => {
          job.status = "scanning";
          job.progress = step.progress;
          job.statusMessage = step.message;
          notify();
        }, triggerAt);
        elapsed += step.delayMs;
      });

      schedule(() => {
        job.status = "completed";
        job.progress = 100;
        job.entryCount = job.afterEntryCount;
        job.hasCompletedRun = true;
        job.runCount += 1;
        job.lastSuccessAt = formatSimulatedTimestamp(nowFn());
        job.statusMessage = `模拟扫描完成：共 ${job.afterEntryCount} 条（较扫描前新增 ${job.addedFiles.length} 个文件：${job.addedFiles.join(", ")}）`;
        notify();
      }, elapsed);

      return { started: true };
    }

    function subscribe(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    function dispose() {
      activeTimers.forEach((timer) => clearTimeout(timer));
      activeTimers.clear();
      listeners.clear();
    }

    return {
      isDemo: true,
      allowManage: true,
      allowTrigger: true,
      demoBannerTitle: "演示模式",
      demoBannerDescription: "这是模拟扫描，不会访问你的设备、服务器或 NAS。",
      listJobs,
      getJob,
      isRunning,
      listRoots,
      browseRootEntries,
      createTask,
      deleteTask,
      startScan,
      subscribe,
      dispose,
    };
  }

  return {
    DEFAULT_STEP_DELAYS,
    DEMO_ALLOWED_ROOTS,
    createDemoScansService,
  };
});
