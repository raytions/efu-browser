import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isPathWithinOrEqual, normalizePosixPath } from "./efu-scan-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CLI_SCRIPT = path.resolve(__dirname, "./efu-scan.mjs");

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SAFE_OUTPUT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.efu$/;

function hasTraversalOrInvalidChars(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) return true;
  if (rawPath.includes("\0") || rawPath.includes("\r") || rawPath.includes("\n")) return true;
  if (rawPath.includes("\\")) return true;
  const segments = rawPath.split("/");
  return segments.some((seg) => seg === "..");
}

export function parseBooleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return defaultValue;
}

export function validateTasksConfig(rawConfig, indexDir) {
  if (!indexDir || typeof indexDir !== "string") {
    throw new Error("缺少必需的受控索引目录 SCANS_INDEX_DIR");
  }
  if (!rawConfig || typeof rawConfig !== "object" || !Array.isArray(rawConfig.tasks)) {
    throw new Error("scans.json 格式无效：顶层必须包含 tasks 数组");
  }

  const resolvedIndexDir = path.resolve(indexDir);
  const seenIds = new Set();
  const seenOutputs = new Set();
  const tasks = [];

  for (let i = 0; i < rawConfig.tasks.length; i++) {
    const raw = rawConfig.tasks[i];
    const label = `tasks[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${label} 无效：必须是对象`);
    }

    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!SAFE_ID_RE.test(id)) {
      throw new Error(`${label}.id 无效：必须为 URL 安全的字母数字/._- 标识`);
    }
    if (seenIds.has(id)) {
      throw new Error(`${label}.id 重复：${id}`);
    }
    seenIds.add(id);

    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) {
      throw new Error(`${label}.name 不能为空`);
    }

    if (typeof raw.allowedRoot !== "string" || !raw.allowedRoot.startsWith("/") || hasTraversalOrInvalidChars(raw.allowedRoot)) {
      throw new Error(`${label}.allowedRoot 必须是无路径穿越的绝对路径`);
    }
    const allowedRoot = normalizePosixPath(raw.allowedRoot);

    if (typeof raw.root !== "string" || !raw.root.startsWith("/") || hasTraversalOrInvalidChars(raw.root)) {
      throw new Error(`${label}.root 必须是无路径穿越的绝对路径`);
    }
    const root = normalizePosixPath(raw.root);

    if (!isPathWithinOrEqual(root, allowedRoot)) {
      throw new Error(`${label}.root 必须等于或位于 allowedRoot 之下`);
    }

    let mountPoint = null;
    if (raw.mountPoint !== undefined && raw.mountPoint !== null && raw.mountPoint !== "") {
      if (typeof raw.mountPoint !== "string" || !raw.mountPoint.startsWith("/") || hasTraversalOrInvalidChars(raw.mountPoint)) {
        throw new Error(`${label}.mountPoint 必须是无路径穿越的绝对路径`);
      }
      mountPoint = normalizePosixPath(raw.mountPoint);
    }

    let excludes = [];
    if (raw.excludes !== undefined && raw.excludes !== null) {
      if (!Array.isArray(raw.excludes)) {
        throw new Error(`${label}.excludes 必须是字符串数组`);
      }
      excludes = raw.excludes.map((entry, idx) => {
        if (
          typeof entry !== "string" ||
          !entry.trim() ||
          entry.includes("\0") ||
          entry.includes("\r") ||
          entry.includes("\n")
        ) {
          throw new Error(`${label}.excludes[${idx}] 无效`);
        }
        return entry.trim();
      });
    }

    let exportPrefix = null;
    if (raw.exportPrefix !== undefined && raw.exportPrefix !== null && raw.exportPrefix !== "") {
      if (
        typeof raw.exportPrefix !== "string" ||
        raw.exportPrefix.includes("\0") ||
        raw.exportPrefix.includes("\r") ||
        raw.exportPrefix.includes("\n")
      ) {
        throw new Error(`${label}.exportPrefix 无效`);
      }
      exportPrefix = raw.exportPrefix;
    }

    const outputName = typeof raw.outputName === "string" ? raw.outputName.trim() : "";
    if (!SAFE_OUTPUT_NAME_RE.test(outputName) || outputName.includes("..")) {
      throw new Error(`${label}.outputName 无效：只允许安全文件名且必须以 .efu 结尾`);
    }
    const outputPath = path.resolve(resolvedIndexDir, outputName);
    if (path.dirname(outputPath) !== resolvedIndexDir) {
      throw new Error(`${label}.outputName 越界：输出必须限制在 SCANS_INDEX_DIR 内`);
    }
    if (seenOutputs.has(outputName)) {
      throw new Error(`${label}.outputName 重复：${outputName}`);
    }
    seenOutputs.add(outputName);

    if (typeof raw.enabled !== "boolean") {
      throw new Error(`${label}.enabled 必须是布尔值`);
    }

    let schedule = null;
    if (raw.schedule !== undefined && raw.schedule !== null && raw.schedule !== "") {
      if (typeof raw.schedule !== "string") {
        throw new Error(`${label}.schedule 必须是字符串`);
      }
      schedule = raw.schedule.trim();
    }

    tasks.push({
      id,
      name,
      root,
      allowedRoot,
      mountPoint,
      excludes,
      exportPrefix,
      outputName,
      outputPath,
      enabled: raw.enabled,
      schedule,
    });
  }

  return tasks;
}

export function loadTasksFile(tasksFilePath, indexDir) {
  let rawText;
  try {
    rawText = fs.readFileSync(tasksFilePath, "utf8");
  } catch (error) {
    throw new Error(`无法读取任务配置文件 "${tasksFilePath}"：${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`任务配置文件 JSON 解析失败：${error.message}`);
  }

  return validateTasksConfig(parsed, indexDir);
}

export function assertRuntimeRootWithinAllowedRoot(task) {
  let realAllowed;
  let realRoot;
  try {
    realAllowed = normalizePosixPath(fs.realpathSync(task.allowedRoot));
    realRoot = normalizePosixPath(fs.realpathSync(task.root));
  } catch (error) {
    throw new Error(`路径校验失败：${error.code || error.message}`);
  }
  if (!isPathWithinOrEqual(realRoot, realAllowed)) {
    throw new Error("扫描路径超出允许根目录边界（allowedRoot）");
  }
}

export function sanitizeScanError(stderrText, exitCode, signal = null) {
  if (signal) {
    return "扫描进程意外中断，已保留上一份快照";
  }
  const msg = String(stderrText || "");
  if (/挂载点检查失败/.test(msg)) {
    return "挂载点校验失败，已保留上一份快照";
  }
  if (/read_error|permission denied|扫描器日志报告错误/i.test(msg)) {
    return "扫描过程中检测到不可读目录或读取错误，已保留上一份快照";
  }
  if (/解析失败|截断|JSON|结构无效/.test(msg)) {
    return "扫描输出校验失败（可能已截断），已保留上一份快照";
  }
  if (/无法启动扫描器/.test(msg)) {
    return "服务器端扫描器不可用，请联系管理员检查配置";
  }
  if (/允许根目录|allowedRoot|路径校验失败/.test(msg)) {
    return "扫描路径未通过安全边界校验";
  }
  if (/无法访问扫描根目录/.test(msg)) {
    return "扫描根目录不可访问，已保留上一份快照";
  }
  if (typeof exitCode === "number" && exitCode !== 0) {
    return `扫描执行失败（退出码 ${exitCode}），已保留上一份快照`;
  }
  return "扫描执行失败，已保留上一份快照";
}

function writeJsonAtomically(filePath, data) {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });
    fs.renameSync(tmpPath, resolved);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw error;
  }
}

export function createScansManager(options = {}) {
  const {
    tasks,
    tasksFile = null,
    indexDir,
    stateFile = null,
    allowTrigger = false,
    gduBin = process.env.EFU_GDU_BIN || "gdu",
    nodeBin = process.execPath,
    cliScriptPath = DEFAULT_CLI_SCRIPT,
    indexUrlPrefix = "/indexes/",
    logger = console,
    now = () => new Date(),
  } = options;

  if (!indexDir) {
    throw new Error("createScansManager requires indexDir");
  }
  const resolvedIndexDir = path.resolve(indexDir);
  fs.mkdirSync(resolvedIndexDir, { recursive: true });

  const validatedTasks = Array.isArray(tasks)
    ? validateTasksConfig({ tasks }, resolvedIndexDir)
    : loadTasksFile(tasksFile, resolvedIndexDir);

  const taskMap = new Map();
  validatedTasks.forEach((task) => taskMap.set(task.id, task));

  const resolvedStateFile = stateFile
    ? path.resolve(stateFile)
    : path.join(resolvedIndexDir, ".scans-state.json");

  const normalizedPrefix = indexUrlPrefix.endsWith("/") ? indexUrlPrefix : `${indexUrlPrefix}/`;
  const runtimeStates = new Map();
  const activeProcesses = new Map();

  function defaultRuntimeState() {
    return {
      status: "idle",
      lastSuccessAt: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      entryCount: null,
      errorSummary: null,
      lastExitCode: null,
    };
  }

  function persistStates() {
    const serialized = {};
    for (const [id, st] of runtimeStates.entries()) {
      serialized[id] = st;
    }
    try {
      writeJsonAtomically(resolvedStateFile, {
        updatedAt: now().toISOString(),
        tasks: serialized,
      });
    } catch (error) {
      logger.error(`[scans-service] 持久化状态文件失败：${error.message}`);
    }
  }

  function loadAndRecoverStates() {
    let savedTasks = {};
    if (fs.existsSync(resolvedStateFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(resolvedStateFile, "utf8"));
        if (parsed && typeof parsed === "object" && parsed.tasks && typeof parsed.tasks === "object") {
          savedTasks = parsed.tasks;
        }
      } catch (error) {
        logger.warn(`[scans-service] 无法解析已有状态文件，将以干净状态启动：${error.message}`);
      }
    }

    let recoveredAny = false;
    for (const task of validatedTasks) {
      const prev = savedTasks[task.id];
      const st = defaultRuntimeState();
      if (prev && typeof prev === "object") {
        if (typeof prev.status === "string") st.status = prev.status;
        if (typeof prev.lastSuccessAt === "string") st.lastSuccessAt = prev.lastSuccessAt;
        if (typeof prev.lastStartedAt === "string") st.lastStartedAt = prev.lastStartedAt;
        if (typeof prev.lastFinishedAt === "string") st.lastFinishedAt = prev.lastFinishedAt;
        if (typeof prev.entryCount === "number" && Number.isFinite(prev.entryCount)) {
          st.entryCount = prev.entryCount;
        }
        if (typeof prev.errorSummary === "string") st.errorSummary = prev.errorSummary;
        if (typeof prev.lastExitCode === "number") st.lastExitCode = prev.lastExitCode;
      }

      // 服务重启后恢复 stale running 状态，避免任务永久卡死在 running
      if (st.status === "running") {
        st.status = "failed";
        st.lastFinishedAt = now().toISOString();
        st.errorSummary = "服务重启导致上次扫描中断，请重新触发";
        recoveredAny = true;
        logger.warn(`[scans-service] 检测到重启前遗留运行状态，已将任务 ${task.id} 恢复为 failed`);
      }

      runtimeStates.set(task.id, st);
    }

    if (recoveredAny) {
      persistStates();
    }
  }

  loadAndRecoverStates();

  function toPublicTask(task) {
    const st = runtimeStates.get(task.id) || defaultRuntimeState();
    const hasSnapshot = fs.existsSync(task.outputPath);
    return {
      id: task.id,
      name: task.name,
      enabled: task.enabled,
      schedule: task.schedule,
      status: st.status,
      lastSuccessAt: st.lastSuccessAt,
      lastStartedAt: st.lastStartedAt,
      lastFinishedAt: st.lastFinishedAt,
      entryCount: st.entryCount,
      errorSummary: st.errorSummary,
      hasSnapshot,
      indexUrl: `${normalizedPrefix}${encodeURIComponent(task.outputName)}`,
    };
  }

  function listPublicTasks() {
    return validatedTasks.map((task) => toPublicTask(task));
  }

  function getPublicTask(id) {
    const task = taskMap.get(id);
    return task ? toPublicTask(task) : null;
  }

  function getIndexUrlInfo(id) {
    const task = taskMap.get(id);
    if (!task) return null;
    return {
      id: task.id,
      url: `${normalizedPrefix}${encodeURIComponent(task.outputName)}`,
      hasSnapshot: fs.existsSync(task.outputPath),
    };
  }

  function triggerScan(id) {
    if (!allowTrigger) {
      return {
        ok: false,
        statusCode: 403,
        error: "当前部署已禁用网页触发扫描（SCANS_ALLOW_TRIGGER=false）",
      };
    }

    const task = taskMap.get(id);
    if (!task) {
      return { ok: false, statusCode: 404, error: "未找到指定的扫描任务" };
    }

    if (!task.enabled) {
      return { ok: false, statusCode: 403, error: "该扫描任务已禁用" };
    }

    const st = runtimeStates.get(task.id);
    if (activeProcesses.has(task.id) || (st && st.status === "running")) {
      return { ok: false, statusCode: 409, error: "该扫描任务正在运行中，请勿重复触发" };
    }

    // 运行前再次基于 realpath 校验符号链接未逃逸 allowedRoot
    try {
      assertRuntimeRootWithinAllowedRoot(task);
    } catch (error) {
      logger.error(`[scans-service] task=${task.id} boundary check failed: ${error.message}`);
      st.status = "failed";
      st.lastStartedAt = now().toISOString();
      st.lastFinishedAt = st.lastStartedAt;
      st.errorSummary = sanitizeScanError(error.message, 1);
      st.lastExitCode = 1;
      persistStates();
      return {
        ok: false,
        statusCode: 400,
        error: st.errorSummary,
        task: toPublicTask(task),
      };
    }

    const cliArgs = [cliScriptPath, "--root", task.root, "--output", task.outputPath];
    for (const ex of task.excludes) {
      cliArgs.push("--exclude", ex);
    }
    if (task.mountPoint) {
      cliArgs.push("--require-mount", task.mountPoint);
    }
    if (task.exportPrefix) {
      cliArgs.push("--export-prefix", task.exportPrefix);
    }
    if (gduBin) {
      cliArgs.push("--gdu-bin", gduBin);
    }

    st.status = "running";
    st.lastStartedAt = now().toISOString();
    st.errorSummary = null;
    st.lastExitCode = null;
    persistStates();

    const child = spawn(nodeBin, cliArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    activeProcesses.set(task.id, child);

    let stdoutBuf = "";
    let stderrBuf = "";
    const MAX_LOG_CHARS = 8192;

    child.stdout.on("data", (chunk) => {
      if (stdoutBuf.length < MAX_LOG_CHARS) {
        stdoutBuf += chunk.toString("utf8").slice(0, MAX_LOG_CHARS - stdoutBuf.length);
      }
    });

    child.stderr.on("data", (chunk) => {
      if (stderrBuf.length < MAX_LOG_CHARS) {
        stderrBuf += chunk.toString("utf8").slice(0, MAX_LOG_CHARS - stderrBuf.length);
      }
    });

    let settled = false;
    const finish = (exitCode, spawnError = null, signal = null) => {
      if (settled) return;
      settled = true;
      activeProcesses.delete(task.id);

      const finishedAt = now().toISOString();
      st.lastFinishedAt = finishedAt;
      st.lastExitCode = typeof exitCode === "number" ? exitCode : 1;

      if (!spawnError && !signal && exitCode === 0) {
        const match = stdoutBuf.match(/entries=(\d+)/);
        const parsedEntries = match ? Number.parseInt(match[1], 10) : null;
        st.status = "succeeded";
        st.lastSuccessAt = finishedAt;
        if (parsedEntries !== null && Number.isFinite(parsedEntries)) {
          st.entryCount = parsedEntries;
        }
        st.errorSummary = null;
        logger.log(
          `[scans-service] task=${task.id} succeeded entries=${st.entryCount ?? "unknown"}`
        );
      } else {
        const combinedErr = spawnError ? spawnError.message : stderrBuf.trim();
        const hasReadError = /read_error|permission denied/i.test(combinedErr);
        const stderrBrief = combinedErr.replace(/\s+/g, " ").slice(0, 300);
        logger.error(
          `[scans-service] task=${task.id} failed exitCode=${st.lastExitCode} signal=${signal || "none"} readError=${hasReadError} stderr="${stderrBrief}"`
        );
        st.status = "failed";
        st.errorSummary = sanitizeScanError(combinedErr, st.lastExitCode, signal);
      }
      persistStates();
    };

    child.on("error", (err) => finish(1, err, null));
    child.on("close", (code, signal) => finish(code, null, signal));

    return {
      ok: true,
      statusCode: 202,
      task: toPublicTask(task),
    };
  }

  async function waitForIdle(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (activeProcesses.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function shutdown() {
    for (const child of activeProcesses.values()) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    activeProcesses.clear();
  }

  return {
    allowTrigger: Boolean(allowTrigger),
    stateFile: resolvedStateFile,
    listPublicTasks,
    getPublicTask,
    getIndexUrlInfo,
    triggerScan,
    waitForIdle,
    shutdown,
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
}

export function createScansHttpServer(manager, options = {}) {
  const rawBase = options.apiBase || "/api/scans";
  const apiBase = rawBase.replace(/\/+$/, "") || "/api/scans";

  return http.createServer((req, res) => {
    const method = (req.method || "GET").toUpperCase();
    let pathname;
    try {
      pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    } catch {
      sendJson(res, 400, { error: "无效的请求路径" });
      return;
    }

    // GET /api/scans
    if (pathname === apiBase || pathname === `${apiBase}/`) {
      if (method !== "GET") {
        sendJson(res, 405, { error: "仅支持 GET 请求" });
        return;
      }
      sendJson(res, 200, {
        mode: "real",
        allowTrigger: manager.allowTrigger,
        tasks: manager.listPublicTasks(),
      });
      return;
    }

    if (!pathname.startsWith(`${apiBase}/`)) {
      sendJson(res, 404, { error: "未找到接口" });
      return;
    }

    const rest = pathname.slice(apiBase.length + 1).split("/").filter(Boolean);
    if (rest.length !== 2) {
      sendJson(res, 404, { error: "未找到接口" });
      return;
    }

    let taskId;
    try {
      taskId = decodeURIComponent(rest[0]);
    } catch {
      sendJson(res, 400, { error: "任务标识格式无效" });
      return;
    }
    const action = rest[1];

    if (!SAFE_ID_RE.test(taskId)) {
      sendJson(res, 400, { error: "任务标识格式无效" });
      return;
    }

    if (action === "run") {
      if (method !== "POST") {
        sendJson(res, 405, { error: "仅支持 POST 请求" });
        return;
      }
      const result = manager.triggerScan(taskId);
      if (!result.ok) {
        sendJson(res, result.statusCode, {
          error: result.error,
          task: result.task || undefined,
        });
        return;
      }
      sendJson(res, result.statusCode, {
        mode: "real",
        allowTrigger: manager.allowTrigger,
        task: result.task,
      });
      return;
    }

    if (action === "status") {
      if (method !== "GET") {
        sendJson(res, 405, { error: "仅支持 GET 请求" });
        return;
      }
      const task = manager.getPublicTask(taskId);
      if (!task) {
        sendJson(res, 404, { error: "未找到指定的扫描任务" });
        return;
      }
      sendJson(res, 200, {
        mode: "real",
        allowTrigger: manager.allowTrigger,
        task,
      });
      return;
    }

    if (action === "index-url") {
      if (method !== "GET") {
        sendJson(res, 405, { error: "仅支持 GET 请求" });
        return;
      }
      const info = manager.getIndexUrlInfo(taskId);
      if (!info) {
        sendJson(res, 404, { error: "未找到指定的扫描任务" });
        return;
      }
      sendJson(res, 200, info);
      return;
    }

    sendJson(res, 404, { error: "未找到接口" });
  });
}
