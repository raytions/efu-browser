(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === "object") {
    root.EfuCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const WINDOWS_EPOCH_DIFFERENCE = 116444736000000000n;
  const HUNDRED_NANOSECONDS = 10000n;
  const DIRECTORY_FLAG = 0x0010;

  const ATTRIBUTE_FLAGS = [
    { mask: 0x0001, label: "只读" },
    { mask: 0x0002, label: "隐藏" },
    { mask: 0x0004, label: "系统" },
    { mask: 0x0008, label: "卷标" },
    { mask: 0x0010, label: "目录" },
    { mask: 0x0020, label: "存档" },
    { mask: 0x0040, label: "设备" },
    { mask: 0x0080, label: "普通" },
    { mask: 0x0100, label: "临时" },
    { mask: 0x0200, label: "稀疏文件" },
    { mask: 0x0400, label: "重解析点" },
    { mask: 0x0800, label: "压缩" },
    { mask: 0x1000, label: "脱机" },
    { mask: 0x4000, label: "加密" },
    { mask: 0x8000, label: "完整性流" },
    { mask: 0x10000, label: "虚拟" },
    { mask: 0x20000, label: "免擦除" },
    { mask: 0x40000, label: "扩展属性" },
    { mask: 0x80000, label: "已固定" },
    { mask: 0x100000, label: "未固定" },
    { mask: 0x200000, label: "按需打开" },
    { mask: 0x400000, label: "按需访问" },
  ];

  const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  function stripBom(text) {
    if (typeof text !== "string") return "";
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  function parseCsv(rawText) {
    const text = stripBom(rawText);
    const rows = [];
    let current = [];
    let value = "";
    let insideQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (char === '"') {
        if (insideQuotes && text[i + 1] === '"') {
          value += '"';
          i += 1;
        } else {
          insideQuotes = !insideQuotes;
        }
        continue;
      }

      if (!insideQuotes && (char === "\n" || char === "\r")) {
        if (char === "\r" && text[i + 1] === "\n") {
          i += 1;
        }
        current.push(value);
        rows.push(current);
        current = [];
        value = "";
        continue;
      }

      if (!insideQuotes && char === ",") {
        current.push(value);
        value = "";
        continue;
      }

      value += char;
    }

    if (insideQuotes) {
      throw new Error("EFU CSV 格式无效：存在未闭合的引号");
    }

    if (value.length > 0 || current.length > 0) {
      current.push(value);
      rows.push(current);
    }

    return rows;
  }

  function safeBigInt(raw) {
    if (raw === null || raw === undefined) return null;
    const trimmed = String(raw).trim();
    if (!/^\d+$/.test(trimmed)) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }

  function safeNumber(raw) {
    if (raw === null || raw === undefined) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    if (/^0x[0-9a-f]+$/i.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 16);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (!/^-?\d+$/.test(trimmed)) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
  }

  function parseEfuTimestamp(raw) {
    if (raw === null || raw === undefined) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;

    // 1. Canonical Everything Windows FILETIME (100-ns ticks since 1601-01-01 UTC)
    if (/^\d+$/.test(trimmed)) {
      try {
        const big = BigInt(trimmed);
        // 0 or values before Unix epoch are treated as missing/unset timestamps
        if (big < WINDOWS_EPOCH_DIFFERENCE) return null;
        return big;
      } catch {
        return null;
      }
    }

    // 2. ISO 8601 date strings (also accepted by Everything EFU)
    if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) {
      const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
      const ms = Date.parse(normalized);
      if (Number.isFinite(ms) && ms >= 0) {
        return BigInt(Math.trunc(ms)) * HUNDRED_NANOSECONDS + WINDOWS_EPOCH_DIFFERENCE;
      }
    }

    return null;
  }

  function extractFileName(fullPath) {
    if (!fullPath) return "";
    if (fullPath === "/" || fullPath === "\\") return fullPath;
    if (/^[a-zA-Z]:[\\/]$/.test(fullPath)) return fullPath;

    const isPosixAbsolute = fullPath.startsWith("/");
    let trimmed = fullPath;
    if (isPosixAbsolute) {
      while (trimmed.length > 1 && trimmed.endsWith("/")) {
        trimmed = trimmed.slice(0, -1);
      }
      const parts = trimmed.split("/").filter((part) => part.length > 0);
      return parts.length ? parts[parts.length - 1] : fullPath;
    }

    while (trimmed.length > 1 && (trimmed.endsWith("/") || trimmed.endsWith("\\"))) {
      // Keep Windows drive root like C:\ or UNC prefix \\
      if (/^[a-zA-Z]:[\\/]$/.test(trimmed) || trimmed === "\\\\") {
        break;
      }
      trimmed = trimmed.slice(0, -1);
    }

    const parts = trimmed.split(/[/\\]/).filter((part) => part.length > 0);
    if (!parts.length) return fullPath;
    return parts[parts.length - 1];
  }

  function parseEfu(text) {
    if (typeof text !== "string") {
      throw new Error("无效的 EFU 内容");
    }

    const rows = parseCsv(text);
    while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === "")) {
      rows.pop();
    }

    if (rows.length === 0) {
      throw new Error("EFU 文件为空，缺少表头");
    }

    const header = rows[0].map((col) => col.trim());
    const headerIndex = new Map();
    header.forEach((col, idx) => {
      const normalized = col.toLowerCase();
      if (normalized && !headerIndex.has(normalized)) {
        headerIndex.set(normalized, idx);
      }
    });

    const filenameIdx = headerIndex.has("filename") ? headerIndex.get("filename") : -1;
    if (filenameIdx === -1) {
      throw new Error("无效的 EFU 文件：表头必须包含 Filename 列");
    }

    const sizeIdx = headerIndex.has("size") ? headerIndex.get("size") : -1;
    const modifiedIdx = headerIndex.has("date modified") ? headerIndex.get("date modified") : -1;
    const createdIdx = headerIndex.has("date created") ? headerIndex.get("date created") : -1;
    const attributesIdx = headerIndex.has("attributes") ? headerIndex.get("attributes") : -1;

    const entries = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every((cell) => cell === "")) {
        continue;
      }

      const fullPath = row[filenameIdx] ?? "";
      if (!fullPath) {
        continue;
      }

      const fileName = extractFileName(fullPath);
      const sizeRaw = sizeIdx >= 0 ? (row[sizeIdx] ?? "") : "";
      const modifiedRaw = modifiedIdx >= 0 ? (row[modifiedIdx] ?? "") : "";
      const createdRaw = createdIdx >= 0 ? (row[createdIdx] ?? "") : "";
      const attributes = attributesIdx >= 0 ? (row[attributesIdx] ?? "") : "";

      const sizeBig = safeBigInt(sizeRaw);
      const modifiedBig = parseEfuTimestamp(modifiedRaw);
      const createdBig = parseEfuTimestamp(createdRaw);
      const attributeNumber = safeNumber(attributes);
      const isDirectory =
        typeof attributeNumber === "number" && (attributeNumber & DIRECTORY_FLAG) === DIRECTORY_FLAG;

      const searchRaw = attributes ? `${fullPath} ${fileName} ${attributes}` : `${fullPath} ${fileName}`;

      entries.push({
        path: fullPath,
        fileName,
        sizeRaw,
        sizeBig,
        modifiedRaw,
        modifiedBig,
        createdRaw,
        createdBig,
        attributes,
        attributeNumber,
        isDirectory,
        searchIndex: searchRaw.toLowerCase(),
        searchRaw,
      });
    }

    return {
      header,
      columns: {
        hasSize: sizeIdx >= 0,
        hasModified: modifiedIdx >= 0,
        hasCreated: createdIdx >= 0,
        hasAttributes: attributesIdx >= 0,
      },
      entries,
    };
  }

  function formatBytesBigInt(bytesBig) {
    if (bytesBig === null || bytesBig === undefined) {
      return "—";
    }
    if (bytesBig === 0n) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let value = bytesBig;
    let unitIndex = 0;
    const step = 1024n;
    while (value >= step && unitIndex < units.length - 1) {
      value = value / step;
      unitIndex += 1;
    }
    if (unitIndex === 0) {
      return `${bytesBig.toString()} B`;
    }
    const remainder = (bytesBig * 1000n) / step ** BigInt(unitIndex);
    const display = Number(remainder) / 1000;
    const precision = display >= 100 ? 0 : display >= 10 ? 1 : 2;
    return `${display.toFixed(precision)} ${units[unitIndex]}`;
  }

  function formatSize(entry) {
    if (!entry || entry.isDirectory) {
      return "—";
    }
    if (entry.sizeBig === null || entry.sizeBig === undefined) {
      return "—";
    }
    return formatBytesBigInt(entry.sizeBig);
  }

  function formatAggregateSize(list) {
    let sum = 0n;
    let hasKnownSize = false;
    for (const item of list) {
      if (!item.isDirectory && item.sizeBig !== null && item.sizeBig !== undefined) {
        sum += item.sizeBig;
        hasKnownSize = true;
      }
    }
    if (!hasKnownSize) {
      return "—";
    }
    return formatBytesBigInt(sum);
  }

  function filetimeToDate(rawBigInt) {
    if (rawBigInt === null || rawBigInt === undefined) return null;
    const diff = rawBigInt - WINDOWS_EPOCH_DIFFERENCE;
    if (diff < 0n) return null;
    const msBig = diff / HUNDRED_NANOSECONDS;
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    if (msBig > maxSafe) return null;
    const date = new Date(Number(msBig));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatFriendlyDate(entry, key) {
    const raw = key === "Date Modified" ? entry.modifiedBig : entry.createdBig;
    const date = filetimeToDate(raw);
    if (!date) {
      return { date: "—", time: "", title: "" };
    }
    const datePart = dateFormatter.format(date);
    const timePart = timeFormatter.format(date);
    return {
      date: datePart,
      time: timePart,
      title: `${datePart} ${timePart}`,
    };
  }

  function formatHttpTimestamp(headerValue) {
    if (!headerValue) return null;
    const date = new Date(headerValue);
    if (Number.isNaN(date.getTime())) return null;
    return `${dateFormatter.format(date)} ${timeFormatter.format(date)}`;
  }

  function describeAttributes(raw) {
    if (!raw) return "—";
    const trimmed = String(raw).trim();
    if (!trimmed) return "—";
    const numeric = safeNumber(trimmed);
    if (numeric === null) {
      return trimmed;
    }
    if (numeric === 0) {
      return "无标记";
    }
    const labels = ATTRIBUTE_FLAGS.filter(({ mask }) => (numeric & mask) === mask).map(
      ({ label }) => label
    );
    if (!labels.length) {
      return trimmed;
    }
    return labels.join("，");
  }

  function tokenizeQuery(query) {
    const tokens = [];
    let current = "";
    let quote = null;
    for (let i = 0; i < query.length; i++) {
      const char = query[i];
      if ((char === '"' || char === "'") && (!quote || quote === char)) {
        if (quote === char) {
          quote = null;
        } else if (!quote) {
          quote = char;
        }
        continue;
      }
      if (!quote && /\s/.test(char)) {
        if (current) {
          tokens.push(current);
          current = "";
        }
        continue;
      }
      current += char;
    }
    if (current) {
      tokens.push(current);
    }
    return tokens;
  }

  function escapeRegexChar(char) {
    return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }

  function buildEverythingRegex(pattern, caseSensitive) {
    try {
      const flags = caseSensitive ? "" : "i";
      return new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`正则无效：${error.message}`);
    }
  }

  function buildWildcardRegex(pattern, caseSensitive) {
    let regexStr = "";
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i];
      if (char === "*") {
        regexStr += ".*";
      } else if (char === "?") {
        regexStr += ".";
      } else {
        regexStr += escapeRegexChar(char);
      }
    }
    regexStr = `.*${regexStr}.*`;
    const flags = caseSensitive ? "s" : "is";
    return new RegExp(regexStr, flags);
  }

  function interpretToken(rawToken, regexMode, caseSensitive) {
    if (!rawToken) return null;
    let negate = false;
    let token = rawToken;
    if (token.startsWith("!")) {
      negate = true;
      token = token.slice(1);
    }
    if (!token) return null;
    let field = "all";
    const lower = token.toLowerCase();
    if (lower.startsWith("file:")) {
      field = "file";
      token = token.slice(5);
    } else if (lower.startsWith("path:")) {
      field = "path";
      token = token.slice(5);
    }
    if (!token) return null;
    const regex = regexMode
      ? buildEverythingRegex(token, caseSensitive)
      : buildWildcardRegex(token, caseSensitive);
    return {
      negate,
      field,
      regex,
    };
  }

  function buildSearchPlan(query, regexMode, caseSensitive) {
    try {
      const rawTokens = tokenizeQuery(query);
      const tokens = rawTokens
        .map((token) => interpretToken(token, regexMode, caseSensitive))
        .filter(Boolean);
      return { tokens };
    } catch (error) {
      return { error: error.message };
    }
  }

  function getTokenTarget(entry, field) {
    if (field === "file") return entry.fileName || "";
    if (field === "path") return entry.path || "";
    return entry.searchRaw || "";
  }

  function matchTokens(entry, tokens) {
    for (const token of tokens) {
      const target = getTokenTarget(entry, token.field);
      const matched = token.regex.test(target);
      if (!token.negate && !matched) {
        return false;
      }
      if (token.negate && matched) {
        return false;
      }
    }
    return true;
  }

  function compareBigInt(a, b) {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    if (a > b) return 1;
    if (a < b) return -1;
    return 0;
  }

  function filterAndSortEntries(entries, options = {}) {
    const {
      query = "",
      regexSearch = false,
      caseSensitive = false,
      includeDirectories = true,
      sortKey = "FileName",
      sortAsc = true,
    } = options;

    const filterDir = (entry) => (includeDirectories ? true : !entry.isDirectory);
    const trimmed = (query || "").trim();

    let filtered;
    let regexError = null;

    if (!trimmed) {
      filtered = entries.filter(filterDir);
    } else {
      const plan = buildSearchPlan(trimmed, regexSearch, caseSensitive);
      if (plan.error) {
        return { filtered: [], regexError: plan.error };
      }
      filtered = entries.filter((entry) => filterDir(entry) && matchTokens(entry, plan.tokens));
    }

    const multiplier = sortAsc ? 1 : -1;
    const collator = new Intl.Collator("zh-CN", { sensitivity: "base", numeric: true });
    const comparators = {
      FileName: (a, b) => collator.compare(a.fileName, b.fileName),
      Path: (a, b) => collator.compare(a.path, b.path),
      Size: (a, b) => compareBigInt(a.sizeBig, b.sizeBig),
      "Date Modified": (a, b) => compareBigInt(a.modifiedBig, b.modifiedBig),
      "Date Created": (a, b) => compareBigInt(a.createdBig, b.createdBig),
      Attributes: (a, b) =>
        collator.compare(describeAttributes(a.attributes), describeAttributes(b.attributes)),
    };

    const compare = comparators[sortKey];
    if (compare) {
      filtered.sort((a, b) => compare(a, b) * multiplier);
    }

    return { filtered, regexError };
  }

  function resolveSameOriginUrl(rawUrl, baseHref) {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
      return { ok: false, error: "索引 URL 不能为空" };
    }
    try {
      const base = new URL(baseHref);
      const resolved = new URL(rawUrl.trim(), base);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
        return { ok: false, error: `不支持的协议：${resolved.protocol}` };
      }
      if (resolved.origin !== base.origin) {
        return { ok: false, error: `仅允许同源 EFU URL，已拒绝跨域地址：${rawUrl}` };
      }
      return {
        ok: true,
        url: resolved.href,
        displayPath: resolved.pathname + resolved.search,
      };
    } catch (error) {
      return { ok: false, error: `无效的索引 URL：${rawUrl}` };
    }
  }

  function normalizeRuntimeConfig(rawConfig, baseHref) {
    const warnings = [];
    if (!rawConfig || typeof rawConfig !== "object") {
      return { defaultIndex: null, indexes: [], warnings };
    }

    const rawList = Array.isArray(rawConfig.indexes) ? rawConfig.indexes : [];
    const indexes = [];
    const seenIds = new Set();

    rawList.forEach((item, idx) => {
      if (!item || typeof item !== "object") {
        warnings.push(`已忽略第 ${idx + 1} 条无效索引配置`);
        return;
      }
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const rawUrl = typeof item.url === "string" ? item.url.trim() : "";
      if (!name || !rawUrl) {
        warnings.push(`已忽略缺少 name 或 url 的索引配置（第 ${idx + 1} 项）`);
        return;
      }
      const resolved = resolveSameOriginUrl(rawUrl, baseHref);
      if (!resolved.ok) {
        warnings.push(`已忽略索引 "${name}"：${resolved.error}`);
        return;
      }
      let id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `index-${idx + 1}`;
      if (seenIds.has(id)) {
        id = `${id}-${idx + 1}`;
      }
      seenIds.add(id);

      indexes.push({
        id,
        name,
        rawUrl,
        url: resolved.url,
        displayPath: resolved.displayPath,
      });
    });

    const requestedDefault =
      typeof rawConfig.defaultIndex === "string" && rawConfig.defaultIndex.trim()
        ? rawConfig.defaultIndex.trim()
        : null;

    let defaultIndex = null;
    if (requestedDefault) {
      const matched = indexes.find(
        (entry) => entry.id === requestedDefault || entry.name === requestedDefault
      );
      defaultIndex = matched ? matched.id : null;
    }
    if (!defaultIndex && indexes.length > 0) {
      defaultIndex = indexes[0].id;
    }

    let scansMode = "demo";
    let scansApiBase = null;
    const rawScans = rawConfig.scans && typeof rawConfig.scans === "object" ? rawConfig.scans : null;
    if (rawScans) {
      const modeStr = typeof rawScans.mode === "string" ? rawScans.mode.trim().toLowerCase() : "demo";
      if (modeStr === "real") {
        scansMode = "real";
        const rawApiBase =
          typeof rawScans.apiBase === "string" && rawScans.apiBase.trim()
            ? rawScans.apiBase.trim()
            : "/api/scans";
        const resolvedApi = resolveSameOriginUrl(rawApiBase, baseHref);
        if (resolvedApi.ok) {
          scansApiBase = resolvedApi.url.replace(/\/+$/, "");
        } else {
          warnings.push(`已忽略无效的 scans.apiBase：${resolvedApi.error}`);
          scansApiBase = resolveSameOriginUrl("/api/scans", baseHref).url?.replace(/\/+$/, "") || null;
        }
      } else if (modeStr !== "demo" && modeStr !== "") {
        warnings.push(`未知的 scans.mode="${modeStr}"，已回退为 demo`);
      }
    }

    return {
      defaultIndex,
      indexes,
      scans: {
        mode: scansMode,
        apiBase: scansApiBase,
      },
      warnings,
    };
  }

  return {
    WINDOWS_EPOCH_DIFFERENCE,
    HUNDRED_NANOSECONDS,
    DIRECTORY_FLAG,
    ATTRIBUTE_FLAGS,
    stripBom,
    parseCsv,
    safeBigInt,
    safeNumber,
    parseEfuTimestamp,
    extractFileName,
    parseEfu,
    formatBytesBigInt,
    formatSize,
    formatAggregateSize,
    filetimeToDate,
    formatFriendlyDate,
    formatHttpTimestamp,
    describeAttributes,
    tokenizeQuery,
    buildEverythingRegex,
    buildWildcardRegex,
    interpretToken,
    buildSearchPlan,
    matchTokens,
    compareBigInt,
    filterAndSortEntries,
    resolveSameOriginUrl,
    normalizeRuntimeConfig,
  };
});
