(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === "object") {
    root.EfuScansRealService = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createRealScansService(options = {}) {
    const apiBase = String(options.apiBase || "/api/scans").replace(/\/+$/, "");
    const pollIntervalMs =
      typeof options.pollIntervalMs === "number" && options.pollIntervalMs >= 100
        ? options.pollIntervalMs
        : 1200;
    const fetchImpl = typeof options.fetch === "function" ? options.fetch : fetch;

    let tasks = [];
    let allowTrigger = false;
    let loading = true;
    let backendError = null;
    let actionError = null;
    let triggeringIds = new Set();
    let pollTimer = null;
    let disposed = false;
    let requestSeq = 0;

    const listeners = new Set();

    function getState() {
      return {
        isDemo: false,
        mode: "real",
        allowTrigger,
        loading,
        backendError,
        actionError,
        jobs: tasks.map((t) => ({
          ...t,
          triggerPending: triggeringIds.has(t.id),
        })),
      };
    }

    function notify() {
      const snapshot = getState();
      listeners.forEach((listener) => {
        try {
          listener(snapshot);
        } catch (error) {
          console.error("Scans real listener error:", error);
        }
      });
    }

    function clearPoll() {
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    }

    function schedulePollIfNeeded() {
      clearPoll();
      if (disposed) return;
      const hasRunning = tasks.some((t) => t.status === "running");
      if (hasRunning) {
        pollTimer = setTimeout(() => {
          pollTimer = null;
          refresh({ silent: true });
        }, pollIntervalMs);
      }
    }

    async function refresh({ silent = false } = {}) {
      if (disposed) return false;
      const seq = ++requestSeq;
      if (!silent) {
        loading = true;
        backendError = null;
        notify();
      }

      try {
        const response = await fetchImpl(apiBase, { cache: "no-store" });
        if (disposed || seq !== requestSeq) return false;

        let data = null;
        try {
          data = await response.json();
        } catch {
          data = null;
        }

        if (!response.ok) {
          const detail = data && data.error ? data.error : `HTTP ${response.status}`;
          throw new Error(`受控扫描服务不可用（${detail}）`);
        }

        if (!data || data.mode !== "real" || !Array.isArray(data.tasks)) {
          throw new Error("扫描服务返回格式无效（未获取到真实任务列表）");
        }

        tasks = data.tasks;
        allowTrigger = Boolean(data.allowTrigger);
        loading = false;
        backendError = null;
        notify();
        schedulePollIfNeeded();
        return true;
      } catch (error) {
        if (disposed || seq !== requestSeq) return false;
        loading = false;
        backendError =
          error && error.message
            ? error.message
            : "无法连接服务器端扫描 API，请确认扫描服务已启动并检查反向代理配置。";
        notify();
        clearPoll();
        return false;
      }
    }

    async function startScan(jobId) {
      if (disposed) return { started: false, reason: "disposed" };
      const existing = tasks.find((t) => t.id === jobId);
      if (!existing) {
        return { started: false, reason: "not_found" };
      }
      if (existing.status === "running" || triggeringIds.has(jobId)) {
        return { started: false, reason: "already_running" };
      }
      if (!allowTrigger) {
        actionError = "当前部署已禁用网页触发扫描（SCANS_ALLOW_TRIGGER=false）。";
        notify();
        return { started: false, reason: "trigger_disabled" };
      }
      if (!existing.enabled) {
        actionError = `任务「${existing.name}」已禁用，无法触发。`;
        notify();
        return { started: false, reason: "disabled" };
      }

      triggeringIds.add(jobId);
      actionError = null;
      notify();

      try {
        const response = await fetchImpl(
          `${apiBase}/${encodeURIComponent(jobId)}/run`,
          {
            method: "POST",
            cache: "no-store",
          }
        );

        let data = null;
        try {
          data = await response.json();
        } catch {
          data = null;
        }

        if (!response.ok) {
          const errMsg = data && data.error ? data.error : `触发扫描失败（HTTP ${response.status}）`;
          actionError = errMsg;
          triggeringIds.delete(jobId);
          notify();
          if (response.status === 409) {
            await refresh({ silent: true });
          }
          return { started: false, statusCode: response.status, error: errMsg };
        }

        if (data && data.task) {
          tasks = tasks.map((t) => (t.id === jobId ? data.task : t));
        }
        triggeringIds.delete(jobId);
        backendError = null;
        actionError = null;
        notify();
        schedulePollIfNeeded();
        return { started: true, task: data?.task || null };
      } catch (error) {
        triggeringIds.delete(jobId);
        actionError =
          error && error.message
            ? `触发扫描请求失败：${error.message}`
            : "无法连接服务器端扫描 API";
        notify();
        return { started: false, error: actionError };
      }
    }

    function listJobs() {
      return getState().jobs;
    }

    function subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    function dispose() {
      disposed = true;
      clearPoll();
      listeners.clear();
    }

    return {
      isDemo: false,
      mode: "real",
      apiBase,
      listJobs,
      getState,
      refresh,
      startScan,
      subscribe,
      dispose,
    };
  }

  return {
    createRealScansService,
  };
});
