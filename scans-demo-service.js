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
      demoBannerTitle: "演示模式",
      demoBannerDescription: "这是模拟扫描，不会访问你的设备、服务器或 NAS。",
      listJobs,
      getJob,
      isRunning,
      startScan,
      subscribe,
      dispose,
    };
  }

  return {
    DEFAULT_STEP_DELAYS,
    createDemoScansService,
  };
});
