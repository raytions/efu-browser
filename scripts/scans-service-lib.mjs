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
const MAX_JSON_BODY_BYTES = 64 * 1024;

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

export function parseAllowedRootsEnv(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  const trimmed = String(rawValue).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`SCANS_ALLOWED_ROOTS JSON 解析失败：${error.message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("SCANS_ALLOWED_ROOTS 必须是路径数组");
    }
    return parsed;
  }
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function makeRootId(rootPath, index, seenIds) {
  const base = path.posix.basename(rootPath).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  let candidate = base ? `root-${base.toLowerCase()}` : `root-${index + 1}`;
  if (!SAFE_ID_RE.test(candidate)) {
    candidate = `root-${index + 1}`;
  }
  if (seenIds.has(candidate)) {
    candidate = `${candidate}-${index + 1}`;
  }
  seenIds.add(candidate);
  return candidate;
}

export function normalizeAllowedRoots(rawRoots) {
  const list = Array.isArray(rawRoots) ? rawRoots : [];
  const seenPaths = new Set();
  const seenIds = new Set();
  const roots = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    let rawPath;
    let rawName = null;
    let rawId = null;

    if (typeof item === "string") {
      rawPath = item.trim();
    } else if (item && typeof item === "object") {
      rawPath = typeof item.path === "string" ? item.path.trim() : "";
      rawName = typeof item.name === "string" && item.name.trim() ? item.name.trim() : null;
      rawId = typeof item.id === "string" && item.id.trim() ? item.id.trim() : null;
    } else {
      throw new Error(`allowedRoots[${i}] 无效：必须是路径字符串或对象`);
    }

    if (!rawPath.startsWith("/") || hasTraversalOrInvalidChars(rawPath)) {
      throw new Error(`allowedRoots[${i}] 必须是无路径穿越的绝对路径`);
    }

    const normPath = normalizePosixPath(rawPath);
    if (seenPaths.has(normPath)) continue;
    seenPaths.add(normPath);

    let id;
    if (rawId) {
      if (!SAFE_ID_RE.test(rawId) || seenIds.has(rawId)) {
        throw new Error(`allowedRoots[${i}].id 无效或重复：${rawId}`);
      }
      seenIds.add(rawId);
      id = rawId;
    } else {
      id = makeRootId(normPath, i, seenIds);
    }

    roots.push({
      id,
      name: rawName || path.posix.basename(normPath) || normPath,
      path: normPath,
    });
  }

  return roots;
}

export function findMatchingAllowedRoot(targetPath, allowedRoots) {
  const normTarget = normalizePosixPath(targetPath);
  // Prefer the most specific (longest) matching allowedRoot
  let best = null;
  for (const root of allowedRoots || []) {
    if (isPathWithinOrEqual(normTarget, root.path)) {
      if (!best || root.path.length > best.path.length) {
        best = root;
      }
    }
  }
  return best;
}

export function validateSingleTask(raw, indexDir, options = {}) {
  const { label = "task", allowedRoots = null } = options;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} 无效：必须是对象`);
  }

  const resolvedIndexDir = path.resolve(indexDir);

  let id = typeof raw.id === "string" ? raw.id.trim() : "";
  let outputName = typeof raw.outputName === "string" ? raw.outputName.trim() : "";
  if (!outputName && id && SAFE_ID_RE.test(id)) {
    outputName = `${id}.efu`;
  }
  if (!SAFE_OUTPUT_NAME_RE.test(outputName) || outputName.includes("..")) {
    throw new Error(`${label}.outputName 无效：只允许安全文件名且必须以 .efu 结尾`);
  }
  const outputPath = path.resolve(resolvedIndexDir, outputName);
  if (path.dirname(outputPath) !== resolvedIndexDir) {
    throw new Error(`${label}.outputName 越界：输出必须限制在 SCANS_INDEX_DIR 内`);
  }

  if (!id) {
    id = outputName.replace(/\.efu$/i, "");
  }
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`${label}.id 无效：必须为 URL 安全的字母数字/._- 标识`);
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    throw new Error(`${label}.name 不能为空`);
  }

  if (typeof raw.root !== "string" || !raw.root.startsWith("/") || hasTraversalOrInvalidChars(raw.root)) {
    throw new Error(`${label}.root 必须是无路径穿越的绝对路径`);
  }
  const root = normalizePosixPath(raw.root);

  let allowedRoot = null;
  if (Array.isArray(allowedRoots) && allowedRoots.length > 0) {
    const matched = findMatchingAllowedRoot(root, allowedRoots);
    if (!matched) {
      throw new Error(`${label}.root 不在任何已授权的 allowedRoots 之下`);
    }
    if (raw.allowedRoot !== undefined && raw.allowedRoot !== null && raw.allowedRoot !== "") {
      if (
        typeof raw.allowedRoot !== "string" ||
        !raw.allowedRoot.startsWith("/") ||
        hasTraversalOrInvalidChars(raw.allowedRoot)
      ) {
        throw new Error(`${label}.allowedRoot 必须是无路径穿越的绝对路径`);
      }
      const normExplicit = normalizePosixPath(raw.allowedRoot);
      if (!isPathWithinOrEqual(root, normExplicit) || !findMatchingAllowedRoot(normExplicit, allowedRoots)) {
        throw new Error(`${label}.allowedRoot 超出系统允许的根目录范围`);
      }
      allowedRoot = normExplicit;
    } else {
      allowedRoot = matched.path;
    }
  } else {
    if (
      typeof raw.allowedRoot !== "string" ||
      !raw.allowedRoot.startsWith("/") ||
      hasTraversalOrInvalidChars(raw.allowedRoot)
    ) {
      throw new Error(`${label}.allowedRoot 必须是无路径穿越的绝对路径`);
    }
    allowedRoot = normalizePosixPath(raw.allowedRoot);
    if (!isPathWithinOrEqual(root, allowedRoot)) {
      throw new Error(`${label}.root 必须等于或位于 allowedRoot 之下`);
    }
  }

  let mountPoint = null;
  if (raw.mountPoint !== undefined && raw.mountPoint !== null && raw.mountPoint !== "") {
    if (
      typeof raw.mountPoint !== "string" ||
      !raw.mountPoint.startsWith("/") ||
      hasTraversalOrInvalidChars(raw.mountPoint)
    ) {
      throw new Error(`${label}.mountPoint 必须是无路径穿越的绝对路径`);
    }
    mountPoint = normalizePosixPath(raw.mountPoint);
  }

  let excludes = [];
  if (raw.excludes !== undefined && raw.excludes !== null) {
    if (!Array.isArray(raw.excludes)) {
      throw new Error(`${label}.excludes 必须是字符串数组`);
    }
    excludes = raw.excludes
      .map((entry, idx) => {
        if (
          typeof entry !== "string" ||
          entry.includes("\0") ||
          entry.includes("\r") ||
          entry.includes("\n")
        ) {
          throw new Error(`${label}.excludes[${idx}] 无效`);
        }
        return entry.trim();
      })
      .filter(Boolean);
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
    exportPrefix = raw.exportPrefix.trim() || null;
  }

  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error(`${label}.enabled 必须是布尔值`);
  }

  let schedule = null;
  if (raw.schedule !== undefined && raw.schedule !== null && raw.schedule !== "") {
    if (typeof raw.schedule !== "string") {
      throw new Error(`${label}.schedule 必须是字符串`);
    }
    schedule = raw.schedule.trim();
  }

  return {
    id,
    name,
    root,
    allowedRoot,
    mountPoint,
    excludes,
    exportPrefix,
    outputName,
    outputPath,
    enabled,
    schedule,
  };
}

export function validateTasksConfig(rawConfig, indexDir, explicitAllowedRoots = null) {
  if (!indexDir || typeof indexDir !== "string") {
    throw new Error("缺少必需的受控索引目录 SCANS_INDEX_DIR");
  }
  if (!rawConfig || typeof rawConfig !== "object" || !Array.isArray(rawConfig.tasks)) {
    throw new Error("scans.json 格式无效：顶层必须包含 tasks 数组");
  }

  const allowedRoots =
    explicitAllowedRoots !== null
      ? normalizeAllowedRoots(explicitAllowedRoots)
      : Array.isArray(rawConfig.allowedRoots) && rawConfig.allowedRoots.length > 0
        ? normalizeAllowedRoots(rawConfig.allowedRoots)
        : null;

  const seenIds = new Set();
  const seenOutputs = new Set();
  const tasks = [];

  for (let i = 0; i < rawConfig.tasks.length; i++) {
    const task = validateSingleTask(rawConfig.tasks[i], indexDir, {
      label: `tasks[${i}]`,
      allowedRoots,
    });
    if (seenIds.has(task.id)) {
      throw new Error(`tasks[${i}].id 重复：${task.id}`);
    }
    seenIds.add(task.id);
    if (seenOutputs.has(task.outputName)) {
      throw new Error(`tasks[${i}].outputName 重复：${task.outputName}`);
    }
    seenOutputs.add(task.outputName);
    tasks.push(task);
  }

  return tasks;
}

export function loadTasksFile(tasksFilePath, indexDir, explicitAllowedRoots = null) {
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

  const tasks = validateTasksConfig(parsed, indexDir, explicitAllowedRoots);
  const configAllowedRoots =
    Array.isArray(parsed.allowedRoots) && parsed.allowedRoots.length > 0
      ? normalizeAllowedRoots(parsed.allowedRoots)
      : null;

  return { tasks, configAllowedRoots };
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
  const stat = fs.statSync(realRoot);
  if (!stat.isDirectory()) {
    throw new Error("扫描路径必须是目录");
  }
}

export function listAllowedRootSubdirectories(allowedRoot, rawRelativePath = "") {
  if (!allowedRoot || !allowedRoot.path) {
    throw Object.assign(new Error("未找到指定的允许根目录"), { statusCode: 404 });
  }

  const relInput = rawRelativePath === undefined || rawRelativePath === null ? "" : String(rawRelativePath).trim();
  if (
    relInput.startsWith("/") ||
    relInput.includes("\\") ||
    relInput.includes("\0") ||
    relInput.includes("\r") ||
    relInput.includes("\n")
  ) {
    throw Object.assign(new Error("目录路径参数无效：仅允许相对允许根目录的子路径"), { statusCode: 400 });
  }

  const rawSegments = relInput ? relInput.split("/").filter((seg) => seg.length > 0) : [];
  if (rawSegments.some((seg) => seg === "." || seg === "..")) {
    throw Object.assign(new Error("目录路径参数包含禁止的穿越片段"), { statusCode: 400 });
  }

  const normAllowed = normalizePosixPath(allowedRoot.path);
  const targetPath =
    rawSegments.length === 0
      ? normAllowed
      : normAllowed === "/"
        ? `/${rawSegments.join("/")}`
        : `${normAllowed}/${rawSegments.join("/")}`;

  if (!isPathWithinOrEqual(targetPath, normAllowed)) {
    throw Object.assign(new Error("请求目录超出允许根目录范围"), { statusCode: 403 });
  }

  let realAllowed;
  let realTarget;
  try {
    realAllowed = normalizePosixPath(fs.realpathSync(normAllowed));
    realTarget = normalizePosixPath(fs.realpathSync(targetPath));
  } catch (error) {
    const code = error && error.code === "ENOENT" ? 404 : 403;
    throw Object.assign(new Error("目录不存在或无权限访问"), { statusCode: code });
  }

  if (!isPathWithinOrEqual(realTarget, realAllowed)) {
    throw Object.assign(new Error("拒绝访问允许根目录之外的符号链接目标"), { statusCode: 403 });
  }

  let targetStat;
  try {
    targetStat = fs.statSync(realTarget);
  } catch {
    throw Object.assign(new Error("无法访问目标目录"), { statusCode: 403 });
  }
  if (!targetStat.isDirectory()) {
    throw Object.assign(new Error("目标路径不是目录"), { statusCode: 400 });
  }

  let dirents;
  try {
    dirents = fs.readdirSync(realTarget, { withFileTypes: true });
  } catch {
    throw Object.assign(new Error("无权限读取该目录下的子目录"), { statusCode: 403 });
  }

  const entries = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    if (!name || name === "." || name === "..") continue;

    let isDir = false;
    if (dirent.isDirectory()) {
      isDir = true;
    } else if (dirent.isSymbolicLink()) {
      // 仅当符号链接指向目录且仍在允许根目录之内时才展示
      try {
        const candidateReal = normalizePosixPath(fs.realpathSync(path.join(realTarget, name)));
        if (isPathWithinOrEqual(candidateReal, realAllowed) && fs.statSync(candidateReal).isDirectory()) {
          isDir = true;
        }
      } catch {
        isDir = false;
      }
    }

    if (!isDir) continue;

    const entryRel = rawSegments.length > 0 ? `${rawSegments.join("/")}/${name}` : name;
    const entryFull = targetPath === "/" ? `/${name}` : `${targetPath}/${name}`;
    entries.push({
      name,
      relativePath: entryRel,
      path: entryFull,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));

  const relativePath = rawSegments.join("/");
  const parentRelativePath =
    rawSegments.length === 0 ? null : rawSegments.slice(0, -1).join("/");

  return {
    rootId: allowedRoot.id,
    rootName: allowedRoot.name,
    rootPath: normAllowed,
    currentPath: targetPath,
    relativePath,
    parentRelativePath,
    entries,
  };
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
    allowedRoots: explicitAllowedRootsOpt = null,
    indexDir,
    stateFile = null,
    allowTrigger = false,
    allowManage = false,
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

  const resolvedTasksFile = tasksFile ? path.resolve(tasksFile) : null;
  const normalizedExplicitRoots =
    explicitAllowedRootsOpt !== null && explicitAllowedRootsOpt !== undefined
      ? normalizeAllowedRoots(explicitAllowedRootsOpt)
      : null;

  let initialTasks = [];
  let configAllowedRoots = null;

  if (Array.isArray(tasks)) {
    initialTasks = validateTasksConfig({ tasks }, resolvedIndexDir, normalizedExplicitRoots);
  } else if (resolvedTasksFile) {
    if (fs.existsSync(resolvedTasksFile)) {
      const loaded = loadTasksFile(resolvedTasksFile, resolvedIndexDir, normalizedExplicitRoots);
      initialTasks = loaded.tasks;
      configAllowedRoots = loaded.configAllowedRoots;
    } else if (allowManage && normalizedExplicitRoots && normalizedExplicitRoots.length > 0) {
      initialTasks = [];
    } else {
      throw new Error(`无法读取任务配置文件 "${resolvedTasksFile}"：文件不存在`);
    }
  } else {
    initialTasks = [];
  }

  // Authoritative allowedRoots priority:
  // 1) Explicit admin-provided allowedRoots (e.g. SCANS_ALLOWED_ROOTS env var)
  // 2) Top-level allowedRoots in scans.json
  // 3) Distinct allowedRoot paths from initial tasks
  let allowedRoots = [];
  if (normalizedExplicitRoots && normalizedExplicitRoots.length > 0) {
    allowedRoots = normalizedExplicitRoots;
  } else if (configAllowedRoots && configAllowedRoots.length > 0) {
    allowedRoots = configAllowedRoots;
  } else {
    const derived = [...new Set(initialTasks.map((t) => t.allowedRoot).filter(Boolean))];
    allowedRoots = normalizeAllowedRoots(derived);
  }

  const allowedRootById = new Map();
  allowedRoots.forEach((r) => allowedRootById.set(r.id, r));

  const taskOrder = [];
  const taskMap = new Map();
  initialTasks.forEach((task) => {
    taskOrder.push(task.id);
    taskMap.set(task.id, task);
  });

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

  function persistTasksFile() {
    if (!resolvedTasksFile) return;
    const payload = {
      allowedRoots: allowedRoots.map((r) => r.path),
      tasks: taskOrder.map((id) => {
        const t = taskMap.get(id);
        return {
          id: t.id,
          name: t.name,
          root: t.root,
          allowedRoot: t.allowedRoot,
          ...(t.mountPoint ? { mountPoint: t.mountPoint } : {}),
          excludes: t.excludes,
          ...(t.exportPrefix ? { exportPrefix: t.exportPrefix } : {}),
          outputName: t.outputName,
          enabled: t.enabled,
          ...(t.schedule ? { schedule: t.schedule } : {}),
        };
      }),
    };
    writeJsonAtomically(resolvedTasksFile, payload);
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
    for (const id of taskOrder) {
      const prev = savedTasks[id];
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

      if (st.status === "running") {
        st.status = "failed";
        st.lastFinishedAt = now().toISOString();
        st.errorSummary = "服务重启导致上次扫描中断，请重新触发";
        recoveredAny = true;
        logger.warn(`[scans-service] 检测到重启前遗留运行状态，已将任务 ${id} 恢复为 failed`);
      }

      runtimeStates.set(id, st);
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
      root: task.root,
      excludes: [...task.excludes],
      exportPrefix: task.exportPrefix,
      outputName: task.outputName,
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

  function listAllowedRoots() {
    return allowedRoots.map((r) => ({ id: r.id, name: r.name, path: r.path }));
  }

  function listRootEntries(rootId, relativePath = "") {
    const rootObj = allowedRootById.get(rootId);
    if (!rootObj) {
      throw Object.assign(new Error("未找到指定的允许根目录"), { statusCode: 404 });
    }
    return listAllowedRootSubdirectories(rootObj, relativePath);
  }

  function listPublicTasks() {
    return taskOrder.map((id) => toPublicTask(taskMap.get(id)));
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

  function createTask(rawInput) {
    if (!allowManage) {
      return {
        ok: false,
        statusCode: 403,
        error: "当前部署已禁用网页管理扫描任务（SCANS_ALLOW_MANAGE=false）",
      };
    }
    if (allowedRoots.length === 0) {
      return {
        ok: false,
        statusCode: 400,
        error: "尚未配置允许的扫描根目录（SCANS_ALLOWED_ROOTS / allowedRoots）",
      };
    }

    let validated;
    try {
      const candidate = { ...rawInput };
      if (candidate.rootId) {
        const chosenRoot = allowedRootById.get(String(candidate.rootId));
        if (!chosenRoot) {
          throw new Error("指定的允许根目录 rootId 不存在");
        }
        candidate.allowedRoot = chosenRoot.path;
      }
      validated = validateSingleTask(candidate, resolvedIndexDir, {
        label: "task",
        allowedRoots,
      });
      if (fs.existsSync(validated.root)) {
        assertRuntimeRootWithinAllowedRoot(validated);
      }
    } catch (error) {
      return { ok: false, statusCode: 400, error: error.message };
    }

    if (taskMap.has(validated.id)) {
      return { ok: false, statusCode: 409, error: `任务标识 "${validated.id}" 已存在` };
    }
    for (const existing of taskMap.values()) {
      if (existing.outputName === validated.outputName) {
        return { ok: false, statusCode: 409, error: `输出文件名 "${validated.outputName}" 已被其他任务使用` };
      }
    }

    taskOrder.push(validated.id);
    taskMap.set(validated.id, validated);
    runtimeStates.set(validated.id, defaultRuntimeState());

    try {
      persistTasksFile();
      persistStates();
    } catch (error) {
      taskOrder.pop();
      taskMap.delete(validated.id);
      runtimeStates.delete(validated.id);
      logger.error(`[scans-service] 保存任务配置失败：${error.message}`);
      return { ok: false, statusCode: 500, error: "保存任务配置失败，请检查任务配置文件写权限" };
    }

    logger.log(`[scans-service] created task id=${validated.id} output=${validated.outputName}`);
    return { ok: true, statusCode: 201, task: toPublicTask(validated) };
  }

  function updateTask(id, patch) {
    if (!allowManage) {
      return {
        ok: false,
        statusCode: 403,
        error: "当前部署已禁用网页管理扫描任务（SCANS_ALLOW_MANAGE=false）",
      };
    }

    const existing = taskMap.get(id);
    if (!existing) {
      return { ok: false, statusCode: 404, error: "未找到指定的扫描任务" };
    }

    const st = runtimeStates.get(id);
    if (activeProcesses.has(id) || (st && st.status === "running")) {
      return { ok: false, statusCode: 409, error: "任务正在运行中，暂不可修改" };
    }

    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return { ok: false, statusCode: 400, error: "无效的修改请求体" };
    }

    const merged = {
      id: existing.id,
      name: patch.name !== undefined ? patch.name : existing.name,
      root: patch.root !== undefined ? patch.root : existing.root,
      allowedRoot:
        patch.allowedRoot !== undefined
          ? patch.allowedRoot
          : patch.root !== undefined && allowedRoots.length > 0
            ? undefined
            : existing.allowedRoot,
      mountPoint: patch.mountPoint !== undefined ? patch.mountPoint : existing.mountPoint,
      excludes: patch.excludes !== undefined ? patch.excludes : existing.excludes,
      exportPrefix: patch.exportPrefix !== undefined ? patch.exportPrefix : existing.exportPrefix,
      outputName: patch.outputName !== undefined ? patch.outputName : existing.outputName,
      enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
      schedule: patch.schedule !== undefined ? patch.schedule : existing.schedule,
    };

    let validated;
    try {
      validated = validateSingleTask(merged, resolvedIndexDir, {
        label: "task",
        allowedRoots: allowedRoots.length > 0 ? allowedRoots : null,
      });
      if (fs.existsSync(validated.root)) {
        assertRuntimeRootWithinAllowedRoot(validated);
      }
    } catch (error) {
      return { ok: false, statusCode: 400, error: error.message };
    }

    for (const other of taskMap.values()) {
      if (other.id !== id && other.outputName === validated.outputName) {
        return { ok: false, statusCode: 409, error: `输出文件名 "${validated.outputName}" 已被其他任务使用` };
      }
    }

    taskMap.set(id, validated);
    try {
      persistTasksFile();
    } catch (error) {
      taskMap.set(id, existing);
      logger.error(`[scans-service] 更新任务配置失败：${error.message}`);
      return { ok: false, statusCode: 500, error: "保存任务配置失败，请检查任务配置文件写权限" };
    }

    logger.log(`[scans-service] updated task id=${id}`);
    return { ok: true, statusCode: 200, task: toPublicTask(validated) };
  }

  function deleteTask(id) {
    if (!allowManage) {
      return {
        ok: false,
        statusCode: 403,
        error: "当前部署已禁用网页管理扫描任务（SCANS_ALLOW_MANAGE=false）",
      };
    }

    const existing = taskMap.get(id);
    if (!existing) {
      return { ok: false, statusCode: 404, error: "未找到指定的扫描任务" };
    }

    const st = runtimeStates.get(id);
    if (activeProcesses.has(id) || (st && st.status === "running")) {
      return { ok: false, statusCode: 409, error: "任务正在运行中，暂不可删除" };
    }

    const prevIdx = taskOrder.indexOf(id);
    taskOrder.splice(prevIdx, 1);
    taskMap.delete(id);
    runtimeStates.delete(id);

    try {
      persistTasksFile();
      persistStates();
    } catch (error) {
      taskOrder.splice(prevIdx, 0, id);
      taskMap.set(id, existing);
      runtimeStates.set(id, st);
      logger.error(`[scans-service] 删除任务配置失败：${error.message}`);
      return { ok: false, statusCode: 500, error: "保存任务配置失败，请检查任务配置文件写权限" };
    }

    // 不删除历史 EFU 快照文件
    logger.log(`[scans-service] deleted task definition id=${id} (historical EFU preserved)`);
    return { ok: true, statusCode: 200, id };
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
    allowManage: Boolean(allowManage),
    stateFile: resolvedStateFile,
    listAllowedRoots,
    listRootEntries,
    listPublicTasks,
    getPublicTask,
    getIndexUrlInfo,
    createTask,
    updateTask,
    deleteTask,
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;

    req.on("data", (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        aborted = true;
        reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("请求体不是有效的 JSON"), { statusCode: 400 }));
      }
    });

    req.on("error", (err) => {
      if (aborted) return;
      reject(Object.assign(new Error(`读取请求失败：${err.message}`), { statusCode: 400 }));
    });
  });
}

export function deriveScanRootsApiBase(apiBase = "/api/scans") {
  const clean = String(apiBase || "/api/scans").replace(/\/+$/, "") || "/api/scans";
  if (clean.endsWith("/scans")) {
    return `${clean.slice(0, -"/scans".length)}/scan-roots`;
  }
  return "/api/scan-roots";
}

export function createScansHttpServer(manager, options = {}) {
  const apiBase = (options.apiBase || "/api/scans").replace(/\/+$/, "") || "/api/scans";
  const rootsBase = (options.rootsApiBase || deriveScanRootsApiBase(apiBase)).replace(/\/+$/, "");

  return http.createServer(async (req, res) => {
    const method = (req.method || "GET").toUpperCase();
    let urlObj;
    try {
      urlObj = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      sendJson(res, 400, { error: "无效的请求路径" });
      return;
    }

    const pathname = urlObj.pathname;

    // ---- /api/scan-roots ----
    if (pathname === rootsBase || pathname === `${rootsBase}/`) {
      if (method !== "GET") {
        sendJson(res, 405, { error: "仅支持 GET 请求" });
        return;
      }
      sendJson(res, 200, {
        mode: "real",
        roots: manager.listAllowedRoots(),
      });
      return;
    }

    if (pathname.startsWith(`${rootsBase}/`)) {
      const rest = pathname.slice(rootsBase.length + 1).split("/").filter(Boolean);
      if (rest.length === 2 && rest[1] === "entries") {
        if (method !== "GET") {
          sendJson(res, 405, { error: "仅支持 GET 请求" });
          return;
        }
        let rootId;
        try {
          rootId = decodeURIComponent(rest[0]);
        } catch {
          sendJson(res, 400, { error: "根目录标识格式无效" });
          return;
        }
        if (!SAFE_ID_RE.test(rootId)) {
          sendJson(res, 400, { error: "根目录标识格式无效" });
          return;
        }
        const relPath = urlObj.searchParams.get("path") || "";
        try {
          const listing = manager.listRootEntries(rootId, relPath);
          sendJson(res, 200, listing);
        } catch (error) {
          sendJson(res, error.statusCode || 400, { error: error.message || "目录枚举失败" });
        }
        return;
      }
      sendJson(res, 404, { error: "未找到接口" });
      return;
    }

    // ---- /api/scans ----
    if (pathname === apiBase || pathname === `${apiBase}/`) {
      if (method === "GET") {
        sendJson(res, 200, {
          mode: "real",
          allowTrigger: manager.allowTrigger,
          allowManage: manager.allowManage,
          tasks: manager.listPublicTasks(),
        });
        return;
      }
      if (method === "POST") {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          sendJson(res, error.statusCode || 400, { error: error.message });
          return;
        }
        const result = manager.createTask(body);
        if (!result.ok) {
          sendJson(res, result.statusCode, { error: result.error });
          return;
        }
        sendJson(res, result.statusCode, {
          mode: "real",
          allowTrigger: manager.allowTrigger,
          allowManage: manager.allowManage,
          task: result.task,
        });
        return;
      }
      sendJson(res, 405, { error: "仅支持 GET 或 POST 请求" });
      return;
    }

    if (!pathname.startsWith(`${apiBase}/`)) {
      sendJson(res, 404, { error: "未找到接口" });
      return;
    }

    const rest = pathname.slice(apiBase.length + 1).split("/").filter(Boolean);
    if (rest.length === 0 || rest.length > 2) {
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
    if (!SAFE_ID_RE.test(taskId)) {
      sendJson(res, 400, { error: "任务标识格式无效" });
      return;
    }

    // PATCH /api/scans/:id & DELETE /api/scans/:id
    if (rest.length === 1) {
      if (method === "PATCH") {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          sendJson(res, error.statusCode || 400, { error: error.message });
          return;
        }
        const result = manager.updateTask(taskId, body);
        if (!result.ok) {
          sendJson(res, result.statusCode, { error: result.error });
          return;
        }
        sendJson(res, result.statusCode, {
          mode: "real",
          allowTrigger: manager.allowTrigger,
          allowManage: manager.allowManage,
          task: result.task,
        });
        return;
      }

      if (method === "DELETE") {
        const result = manager.deleteTask(taskId);
        if (!result.ok) {
          sendJson(res, result.statusCode, { error: result.error });
          return;
        }
        sendJson(res, result.statusCode, {
          deleted: true,
          id: result.id,
        });
        return;
      }

      sendJson(res, 405, { error: "仅支持 PATCH 或 DELETE 请求" });
      return;
    }

    const action = rest[1];

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
        allowManage: manager.allowManage,
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
        allowManage: manager.allowManage,
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
