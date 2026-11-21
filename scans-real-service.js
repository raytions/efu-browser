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

  function deriveRootsApiBase(apiBase) {
    const clean = String(apiBase || "/api/scans").replace(/\/+$/, "") || "/api/scans";
    if (clean.endsWith("/scans")) {
      return `${clean.slice(0, -"/scans".length)}/scan-roots`;
    }
    return "/api/scan-roots";
  }

  function createRealScansService(options = {}) {
    const apiBase = String(options.apiBase || "/api/scans").replace(/\/+$/, "");
    const rootsApiBase = String(
      options.rootsApiBase || deriveRootsApiBase(apiBase)
    ).replace(/\/+$/, "");
    const pollIntervalMs =
      typeof options.pollIntervalMs === "number" && options.pollIntervalMs >= 100
        ? options.pollIntervalMs
        : 1200;
    const fetchImpl = typeof options.fetch === "function" ? options.fetch : fetch;

    let tasks = [];
    let allowTrigger = false;
    let allowManage = false;
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
        allowManage,
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

    async function parseJsonSafe(response) {
      try {
        return await response.json();
      } catch {
        return null;
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

        const data = await parseJsonSafe(response);

        if (!response.ok) {
          const detail = data && data.error ? data.error : `HTTP ${response.status}`;
          throw new Error(`受控扫描服务不可用（${detail}）`);
        }

        if (!data || data.mode !== "real" || !Array.isArray(data.tasks)) {
          throw new Error("扫描服务返回格式无效（未获取到真实任务列表）");
        }

        tasks = data.tasks;
        allowTrigger = Boolean(data.allowTrigger);
        allowManage = Boolean(data.allowManage);
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

    async function listRoots() {
      if (disposed) return { ok: false, roots: [], error: "服务已释放" };
      try {
        const response = await fetchImpl(rootsApiBase, { cache: "no-store" });
        const data = await parseJsonSafe(response);
        if (!response.ok) {
          return {
            ok: false,
            roots: [],
            statusCode: response.status,
            error: (data && data.error) || `获取允许扫描根目录失败（HTTP ${response.status}）`,
          };
        }
        if (!data || !Array.isArray(data.roots)) {
          return { ok: false, roots: [], error: "服务器返回的根目录列表格式无效" };
        }
        return { ok: true, roots: data.roots };
      } catch (error) {
        return {
          ok: false,
          roots: [],
          error: (error && error.message) || "无法连接目录枚举接口",
        };
      }
    }

    async function browseRootEntries(rootId, relativePath = "") {
      if (disposed) return { ok: false, error: "服务已释放" };
      const encodedRootId = encodeURIComponent(String(rootId || ""));
      const query = relativePath
        ? `?path=${encodeURIComponent(String(relativePath))}`
        : "";
      try {
        const response = await fetchImpl(`${rootsApiBase}/${encodedRootId}/entries${query}`, {
          cache: "no-store",
        });
        const data = await parseJsonSafe(response);
        if (!response.ok) {
          return {
            ok: false,
            statusCode: response.status,
            error: (data && data.error) || `读取子目录失败（HTTP ${response.status}）`,
          };
        }
        if (!data || !Array.isArray(data.entries)) {
          return { ok: false, error: "服务器返回的子目录数据格式无效" };
        }
        return { ok: true, data };
      } catch (error) {
        return {
          ok: false,
          error: (error && error.message) || "无法读取服务器子目录列表",
        };
      }
    }

    async function createTask(payload) {
      if (disposed) return { ok: false, error: "服务已释放" };
      if (!allowManage) {
        return {
          ok: false,
          statusCode: 403,
          error: "当前部署已禁用网页管理扫描任务（SCANS_ALLOW_MANAGE=false）。",
        };
      }
      try {
        const response = await fetchImpl(apiBase, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload || {}),
          cache: "no-store",
        });
        const data = await parseJsonSafe(response);
        if (!response.ok) {
          return {
            ok: false,
            statusCode: response.status,
            error: (data && data.error) || `创建扫描任务失败（HTTP ${response.status}）`,
          };
        }
        if (data && data.task) {
          tasks = [...tasks, data.task];
        }
        actionError = null;
        notify();
        return { ok: true, statusCode: response.status, task: data?.task || null };
      } catch (error) {
        return {
          ok: false,
          error: (error && error.message) || "无法连接服务器端扫描 API",
        };
      }
    }

    async function updateTask(jobId, payload) {
      if (disposed) return { ok: false, error: "服务已释放" };
      if (!allowManage) {
        return {
          ok: false,
          statusCode: 403,
          error: "当前部署已禁用网页管理扫描任务（SCANS_ALLOW_MANAGE=false）。",
        };
      }
      try {
        const response = await fetchImpl(`${apiBase}/${encodeURIComponent(jobId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload || {}),
          cache: "no-store",
        });
        const data = await parseJsonSafe(response);
        if (!response.ok) {
          return {
            ok: false,
            statusCode: response.status,
            error: (data && data.error) || `修改扫描任务失败（HTTP ${response.status}）`,
          };
        }
        if (data && data.task) {
          tasks = tasks.map((t) => (t.id === jobId ? data.task : t));
        }
        actionError = null;
        notify();
        return { ok: true, statusCode: response.status, task: data?.task || null };
      } catch (error) {
        return {
          ok: false,
          error: (error && error.message) || "无法连接服务器端扫描 API",
        };
      }
    }

    async function deleteTask(jobId) {
      if (disposed) return { ok: false, error: "服务已释放" };
      if (!allowManage) {
        actionError = "当前部署已禁用网页管理扫描任务（SCANS_ALLOW_MANAGE=false）。";
        notify();
        return { ok: false, statusCode: 403, error: actionError };
      }
      try {
        const response = await fetchImpl(`${apiBase}/${encodeURIComponent(jobId)}`, {
          method: "DELETE",
          cache: "no-store",
        });
        const data = await parseJsonSafe(response);
        if (!response.ok) {
          const errMsg = (data && data.error) || `删除扫描任务失败（HTTP ${response.status}）`;
          actionError = errMsg;
          notify();
          return { ok: false, statusCode: response.status, error: errMsg };
        }
        tasks = tasks.filter((t) => t.id !== jobId);
        actionError = null;
        notify();
        return { ok: true, statusCode: response.status, id: jobId };
      } catch (error) {
        actionError = (error && error.message) || "无法连接服务器端扫描 API";
        notify();
        return { ok: false, error: actionError };
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

        const data = await parseJsonSafe(response);

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
      rootsApiBase,
      listJobs,
      getState,
      refresh,
      listRoots,
      browseRootEntries,
      createTask,
      updateTask,
      deleteTask,
      startScan,
      subscribe,
      dispose,
    };
  }

  return {
    deriveRootsApiBase,
    createRealScansService,
  };
});
