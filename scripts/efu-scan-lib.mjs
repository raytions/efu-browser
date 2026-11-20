import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const WINDOWS_EPOCH_DIFFERENCE = 116444736000000000n;
export const TICKS_PER_SECOND = 10000000n;
export const EFU_HEADER = "Filename,Size,Date Modified";

const BENIGN_GDU_LOG_PATTERNS = [
  /^time="[^"]*"\s+level=info\s+msg="Runtime flags: .*"$/,
  /^time="[^"]*"\s+level=info\s+msg="Ignoring dirs .*"$/,
  /^time="[^"]*"\s+level=info\s+msg="Ignoring dir patterns .*"$/,
  /^time="[^"]*"\s+level=info\s+msg="Reading ignoring dir patterns from file .*"$/,
  /^time="[^"]*"\s+level=info\s+msg="Max cores set to \d+"$/,
  /^time="[^"]*"\s+level=info\s+msg="Analyzing path: .*"$/,
  /^time="[^"]*"\s+level=info\s+msg="Directory .* ignored"$/,
];

export function escapeCsvField(value) {
  const str = String(value ?? "");
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

export function unixSecondsToFiletime(unixSeconds) {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds) || unixSeconds < 0) {
    return "";
  }
  return (BigInt(Math.trunc(unixSeconds)) * TICKS_PER_SECOND + WINDOWS_EPOCH_DIFFERENCE).toString();
}

export function escapeRegexLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizePosixPath(p) {
  if (!p) return "";
  const resolved = path.posix.resolve(p);
  return resolved.length > 1 && resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

export function isPathWithinOrEqual(targetPath, parentPath) {
  const normTarget = normalizePosixPath(targetPath);
  const normParent = normalizePosixPath(parentPath);
  if (normTarget === normParent) return true;
  if (normParent === "/") return normTarget.startsWith("/");
  return normTarget.startsWith(`${normParent}/`);
}

export function unescapeMountinfoPath(raw) {
  return raw.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(Number.parseInt(oct, 8)));
}

export function parseMountinfo(content) {
  const mounts = new Set();
  const lines = String(content || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(" ");
    // /proc/self/mountinfo field 5 (index 4) is the mount point
    if (fields.length < 5) continue;
    const mountPoint = normalizePosixPath(unescapeMountinfoPath(fields[4]));
    if (mountPoint) {
      mounts.add(mountPoint);
    }
  }
  return mounts;
}

export function verifyRequiredMount({
  requireMount,
  scanRoot,
  mountinfoPath = "/proc/self/mountinfo",
}) {
  if (!requireMount) return;

  let canonicalMount;
  try {
    canonicalMount = normalizePosixPath(fs.realpathSync(requireMount));
  } catch (error) {
    throw new Error(`挂载点检查失败：无法访问挂载点 "${requireMount}" (${error.message})`);
  }

  let canonicalRoot;
  try {
    canonicalRoot = normalizePosixPath(fs.realpathSync(scanRoot));
  } catch (error) {
    throw new Error(`挂载点检查失败：无法访问扫描根目录 "${scanRoot}" (${error.message})`);
  }

  if (!isPathWithinOrEqual(canonicalRoot, canonicalMount)) {
    throw new Error(
      `挂载点检查失败：扫描根目录 "${canonicalRoot}" 不在要求挂载点 "${canonicalMount}" 之下`
    );
  }

  let mountinfoText;
  try {
    mountinfoText = fs.readFileSync(mountinfoPath, "utf8");
  } catch (error) {
    throw new Error(`挂载点检查失败：无法读取 "${mountinfoPath}" (${error.message})`);
  }

  const activeMounts = parseMountinfo(mountinfoText);
  if (!activeMounts.has(canonicalMount)) {
    throw new Error(
      `挂载点检查失败："${canonicalMount}" 当前未出现在活动挂载表 (${mountinfoPath}) 中`
    );
  }
}

export function buildGduExcludeRegexes(excludes, resolvedRoot) {
  const normRoot = normalizePosixPath(resolvedRoot);
  const regexes = [];

  for (const rawItem of excludes || []) {
    const item = String(rawItem ?? "").trim();
    if (!item) continue;

    // Strip leading ./ and trailing /
    let cleaned = item.replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!cleaned) continue;

    if (cleaned.includes("/")) {
      // Relative path from scan root (strip leading / if user provided one)
      cleaned = cleaned.replace(/^\/+/, "");
      if (!cleaned) continue;
      const targetFullPath = normRoot === "/" ? `/${cleaned}` : `${normRoot}/${cleaned}`;
      regexes.push(escapeRegexLiteral(targetFullPath));
    } else {
      // Directory basename at any depth
      regexes.push(`(.*/)?${escapeRegexLiteral(cleaned)}`);
    }
  }

  return regexes;
}

export function formatExportPath(fullPath, resolvedRoot, exportPrefix) {
  if (!exportPrefix) {
    return fullPath;
  }

  const normRoot = normalizePosixPath(resolvedRoot);
  const normFull = normalizePosixPath(fullPath);

  if (!isPathWithinOrEqual(normFull, normRoot)) {
    throw new Error(`导出路径越界："${normFull}" 不在扫描根目录 "${normRoot}" 之内`);
  }

  let rel = "";
  if (normFull !== normRoot) {
    rel = normRoot === "/" ? normFull.slice(1) : normFull.slice(normRoot.length + 1);
  }

  const useBackslash = exportPrefix.includes("\\");
  const sep = useBackslash ? "\\" : "/";

  // Trim trailing separator from prefix unless it's a root like "/" or "C:\" or "\\"
  let cleanPrefix = exportPrefix;
  while (
    cleanPrefix.length > 1 &&
    (cleanPrefix.endsWith("/") || cleanPrefix.endsWith("\\")) &&
    !/^[a-zA-Z]:[\\/]$/.test(cleanPrefix) &&
    cleanPrefix !== "\\\\"
  ) {
    cleanPrefix = cleanPrefix.slice(0, -1);
  }

  if (!rel) {
    return cleanPrefix;
  }

  const relSegments = rel.split("/").filter(Boolean);
  const joinedRel = relSegments.join(sep);

  if (cleanPrefix.endsWith(sep)) {
    return `${cleanPrefix}${joinedRel}`;
  }
  return `${cleanPrefix}${sep}${joinedRel}`;
}

export function inspectGduLog(logText) {
  const suspicious = [];
  const lines = String(logText || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const isBenign = BENIGN_GDU_LOG_PATTERNS.some((pattern) => pattern.test(line));
    if (!isBenign) {
      suspicious.push(line);
    }
  }
  return suspicious;
}

export function validateAndExtractGduJson(jsonData, resolvedRoot, exportPrefix) {
  if (!Array.isArray(jsonData) || jsonData.length < 4) {
    throw new Error("gdu JSON 输出结构无效：缺少标准 ncdu/gdu 顶层数组");
  }

  const [major, minor, metadata, rootNode] = jsonData;
  if (typeof major !== "number" || typeof minor !== "number") {
    throw new Error("gdu JSON 输出结构无效：版本号格式错误");
  }
  if (!metadata || typeof metadata !== "object" || metadata.progname !== "gdu") {
    throw new Error(
      `gdu JSON 输出元数据无效：预期 progname="gdu"，实际为 ${JSON.stringify(metadata?.progname)}`
    );
  }
  if (!Array.isArray(rootNode) || rootNode.length === 0 || typeof rootNode[0] !== "object" || rootNode[0] === null) {
    throw new Error("gdu JSON 输出结构无效：根目录节点缺失");
  }

  const scannerVersion = typeof metadata.progver === "string" ? metadata.progver : "unknown";
  const normRoot = normalizePosixPath(resolvedRoot);
  const rootMeta = rootNode[0];
  if (typeof rootMeta.name !== "string" || !rootMeta.name) {
    throw new Error("gdu JSON 输出结构无效：根目录缺少 name 字段");
  }

  const reportedRoot = normalizePosixPath(rootMeta.name);
  if (reportedRoot !== normRoot) {
    throw new Error(
      `gdu JSON 根目录不匹配：预期 "${normRoot}"，实际导出 "${reportedRoot}"`
    );
  }

  const rows = [];
  const readErrors = [];

  function walkDir(dirArray, currentPath, isRoot) {
    if (!Array.isArray(dirArray) || dirArray.length === 0) {
      throw new Error(`gdu JSON 目录节点无效：${currentPath}`);
    }
    const meta = dirArray[0];
    if (!meta || typeof meta !== "object" || Array.isArray(meta) || typeof meta.name !== "string") {
      throw new Error(`gdu JSON 目录元数据无效：${currentPath}`);
    }

    const dirPath = isRoot
      ? normRoot
      : currentPath === "/"
        ? `/${meta.name}`
        : `${currentPath}/${meta.name}`;

    if (meta.read_error === true) {
      readErrors.push(dirPath);
      return;
    }

    for (let i = 1; i < dirArray.length; i++) {
      const child = dirArray[i];
      if (Array.isArray(child)) {
        walkDir(child, dirPath, false);
      } else if (child && typeof child === "object") {
        if (typeof child.name !== "string" || !child.name) {
          throw new Error(`gdu JSON 文件节点缺少 name 字段（位于 ${dirPath}）`);
        }
        if (child.read_error === true) {
          readErrors.push(dirPath === "/" ? `/${child.name}` : `${dirPath}/${child.name}`);
          continue;
        }
        const filePath = dirPath === "/" ? `/${child.name}` : `${dirPath}/${child.name}`;
        const exportedPath = formatExportPath(filePath, normRoot, exportPrefix);

        // Regular files: gdu omits `asize` when apparent size is 0 bytes.
        // Non-regular entries (symlinks, sockets, pipes): leave Size blank rather than
        // reporting symlink target-string length as a file size.
        let sizeStr = "";
        if (child.notreg !== true) {
          if (child.asize === undefined || child.asize === null) {
            sizeStr = "0";
          } else if (typeof child.asize === "number" && Number.isFinite(child.asize) && child.asize >= 0) {
            sizeStr = String(Math.trunc(child.asize));
          } else {
            throw new Error(`gdu JSON 文件大小无效：${filePath} -> ${JSON.stringify(child.asize)}`);
          }
        }

        const modifiedStr =
          typeof child.mtime === "number" && Number.isFinite(child.mtime)
            ? unixSecondsToFiletime(child.mtime)
            : "";

        rows.push({
          filename: exportedPath,
          size: sizeStr,
          dateModified: modifiedStr,
        });
      } else {
        throw new Error(`gdu JSON 包含未知节点类型（位于 ${dirPath}）`);
      }
    }
  }

  walkDir(rootNode, normRoot, true);

  if (readErrors.length > 0) {
    const sample = readErrors.slice(0, 5).join(", ");
    const extra = readErrors.length > 5 ? ` 等共 ${readErrors.length} 处` : "";
    throw new Error(`检测到部分扫描/读取错误（read_error=true）：${sample}${extra}`);
  }

  return {
    scanner: "gdu",
    scannerVersion,
    rows,
  };
}

export function writeEfuAtomically(outputPath, rows, beforePublish) {
  const resolvedOutput = path.resolve(outputPath);
  const outputDir = path.dirname(resolvedOutput);
  const baseName = path.basename(resolvedOutput);

  let dirStat;
  try {
    dirStat = fs.statSync(outputDir);
  } catch (error) {
    throw new Error(`输出目录不存在或不可访问："${outputDir}" (${error.message})`);
  }
  if (!dirStat.isDirectory()) {
    throw new Error(`输出路径的父级不是目录："${outputDir}"`);
  }

  const rand = crypto.randomBytes(6).toString("hex");
  const tmpPath = path.join(outputDir, `.${baseName}.${process.pid}.${rand}.tmp`);

  let fd = null;
  try {
    fd = fs.openSync(tmpPath, "wx", 0o644);
    const bufferLines = [`${EFU_HEADER}\r\n`];
    let bufferedBytes = bufferLines[0].length;
    const FLUSH_THRESHOLD = 256 * 1024;

    const flush = () => {
      if (bufferLines.length === 0) return;
      fs.writeSync(fd, bufferLines.join(""), null, "utf8");
      bufferLines.length = 0;
      bufferedBytes = 0;
    };

    for (const row of rows) {
      const line = `${escapeCsvField(row.filename)},${row.size},${row.dateModified}\r\n`;
      bufferLines.push(line);
      bufferedBytes += line.length;
      if (bufferedBytes >= FLUSH_THRESHOLD) {
        flush();
      }
    }
    flush();

    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    if (typeof beforePublish === "function") {
      beforePublish();
    }

    fs.renameSync(tmpPath, resolvedOutput);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failure on cleanup
      }
    }
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // ignore unlink failure on cleanup
    }
    throw error;
  }
}

export function runScanToEfu(options) {
  const startNs = process.hrtime.bigint();
  const {
    root,
    output,
    excludes = [],
    requireMount = null,
    exportPrefix = null,
    gduBin = process.env.EFU_GDU_BIN || "gdu",
    mountinfoPath = "/proc/self/mountinfo",
    beforePublish = null,
    transformHook = null,
  } = options || {};

  if (!root || typeof root !== "string") {
    throw new Error("缺少必需参数 --root");
  }
  if (!output || typeof output !== "string") {
    throw new Error("缺少必需参数 --output");
  }

  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch (error) {
    throw new Error(`无法访问扫描根目录 "${root}"：${error.message}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`扫描根目录 "${root}" 不是目录`);
  }

  const resolvedRoot = normalizePosixPath(fs.realpathSync(root));
  const resolvedOutput = path.resolve(output);

  // Pre-scan mountpoint verification
  verifyRequiredMount({
    requireMount,
    scanRoot: resolvedRoot,
    mountinfoPath,
  });

  const tempWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-scan-"));
  const tmpJsonPath = path.join(tempWorkDir, "gdu-output.json");
  const tmpLogPath = path.join(tempWorkDir, "gdu.log");
  const tmpExcludePath = path.join(tempWorkDir, "excludes.txt");

  try {
    const gduArgs = [
      "--config-file",
      "/dev/null",
      "-n",
      "-p",
      "-l",
      tmpLogPath,
      "-o",
      tmpJsonPath,
    ];

    const excludeRegexes = buildGduExcludeRegexes(excludes, resolvedRoot);
    if (excludeRegexes.length > 0) {
      fs.writeFileSync(tmpExcludePath, `${excludeRegexes.join("\n")}\n`, "utf8");
      gduArgs.push("-X", tmpExcludePath);
    }

    gduArgs.push(resolvedRoot);

    const proc = spawnSync(gduBin, gduArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });

    if (proc.error) {
      throw new Error(`无法启动扫描器 "${gduBin}"：${proc.error.message}`);
    }
    if (proc.signal) {
      throw new Error(`扫描器 "${gduBin}" 被信号终止：${proc.signal}`);
    }
    if (proc.status !== 0) {
      const stderrMsg = (proc.stderr || "").trim();
      throw new Error(
        `扫描器 "${gduBin}" 退出异常 (code=${proc.status})${stderrMsg ? `：${stderrMsg}` : ""}`
      );
    }

    const stderrText = (proc.stderr || "").trim();
    if (stderrText) {
      throw new Error(`扫描器 "${gduBin}" 输出了未预期的错误流：${stderrText}`);
    }

    if (fs.existsSync(tmpLogPath)) {
      const logText = fs.readFileSync(tmpLogPath, "utf8");
      const suspiciousLogLines = inspectGduLog(logText);
      if (suspiciousLogLines.length > 0) {
        throw new Error(
          `扫描器日志报告错误，拒绝发布不完整快照：${suspiciousLogLines.slice(0, 3).join(" | ")}`
        );
      }
    }

    if (!fs.existsSync(tmpJsonPath)) {
      throw new Error("扫描器未生成 JSON 输出文件");
    }

    const rawJsonText = fs.readFileSync(tmpJsonPath, "utf8");
    if (!rawJsonText.trim()) {
      throw new Error("扫描器输出的 JSON 文件为空");
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(rawJsonText);
    } catch (error) {
      throw new Error(`扫描器 JSON 输出解析失败（可能已截断）：${error.message}`);
    }

    const extracted = validateAndExtractGduJson(parsedJson, resolvedRoot, exportPrefix);

    if (typeof transformHook === "function") {
      transformHook(extracted);
    }

    writeEfuAtomically(resolvedOutput, extracted.rows, () => {
      // Pre-publish mountpoint verification
      verifyRequiredMount({
        requireMount,
        scanRoot: resolvedRoot,
        mountinfoPath,
      });
      if (typeof beforePublish === "function") {
        beforePublish();
      }
    });

    const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    return {
      scanner: extracted.scanner,
      scannerVersion: extracted.scannerVersion,
      root: resolvedRoot,
      output: resolvedOutput,
      entryCount: extracted.rows.length,
      durationMs: Math.round(durationMs * 100) / 100,
    };
  } finally {
    try {
      fs.rmSync(tempWorkDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
