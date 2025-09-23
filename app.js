const PRESET_DIRECTORY = "/efu/";
const DEFAULT_FILE_NAME = "Software.efu";
const DEFAULT_FILE = `${PRESET_DIRECTORY}${DEFAULT_FILE_NAME}`;
const WINDOWS_EPOCH_DIFFERENCE = 116444736000000000n;
const HUNDRED_NANOSECONDS = 10000n;
const DEFAULT_PAGE_SIZE = 20;
const DIRECTORY_FLAG = 0x0010;

const COLUMN_CLASSES = {
  FileName: "col-file",
  Path: "col-path",
  Size: "col-size",
  "Date Modified": "col-modified",
  "Date Created": "col-created",
  Attributes: "col-attributes",
};

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

const THEME_SEQUENCE = ["light", "dark", "mac"];
const THEME_META = {
  light: { icon: "☀️", label: "明亮", className: "theme-light" },
  dark: { icon: "🌙", label: "暗黑", className: "theme-dark" },
  mac: { icon: "🍎", label: "macOS 26", className: "theme-mac" },
};

function resolveInitialTheme() {
  try {
    const stored = localStorage.getItem("efu-theme");
    if (stored && THEME_SEQUENCE.includes(stored)) {
      return stored;
    }
  } catch (error) {
    // 忽略存储异常
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
  }
  return "light";
}

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

const state = {
  entries: [],
  filtered: [],
  sortKey: "FileName",
  sortAsc: true,
  manifest: [],
  activeSource: null,
  regexSearch: false,
  regexError: null,
  pageSize: DEFAULT_PAGE_SIZE,
  page: 0,
  includeDirectories: true,
  caseSensitive: false,
  theme: resolveInitialTheme(),
  progressive: true,
  visibleColumns: {
    FileName: true,
    Path: true,
    Size: true,
    "Date Modified": true,
    "Date Created": true,
    Attributes: true,
  },
};

const refs = {
  totalCount: document.getElementById("total-count"),
  filteredCount: document.getElementById("filtered-count"),
  filteredSize: document.getElementById("filtered-size"),
  results: document.getElementById("results"),
  searchInput: document.getElementById("search-input"),
  clearSearch: document.getElementById("clear-search"),
  loader: document.getElementById("loader"),
  headers: Array.from(document.querySelectorAll("thead th")),
  activeSource: document.getElementById("active-source"),
  footerSource: document.getElementById("footer-source"),
  fileSelector: document.getElementById("file-selector"),
  loadSelected: document.getElementById("load-selected"),
  fileUpload: document.getElementById("file-upload"),
  uploadTrigger: document.getElementById("upload-trigger"),
  toggleRegex: document.getElementById("toggle-regex"),
  toggleIncludeDirs: document.getElementById("toggle-include-dirs"),
  toggleCaseSensitive: document.getElementById("toggle-case-sensitive"),
  uploadName: document.getElementById("upload-name"),
  openSource: document.getElementById("open-source"),
  closeSource: document.getElementById("close-source"),
  openSettings: document.getElementById("open-settings"),
  closeSettings: document.getElementById("close-settings"),
  overlay: document.getElementById("dialog-overlay"),
  sourcePanel: document.getElementById("source-panel"),
  settingsPanel: document.getElementById("settings-panel"),
  pageSize: document.getElementById("page-size"),
  prevPage: document.getElementById("prev-page"),
  nextPage: document.getElementById("next-page"),
  currentPage: document.getElementById("current-page"),
  totalPages: document.getElementById("total-pages"),
  pageJump: document.getElementById("page-jump"),
  columnToggles: Array.from(document.querySelectorAll("[data-column-toggle]")),
  columnSettingsToggle: document.getElementById("column-settings-toggle"),
  columnPopover: document.getElementById("column-popover"),
  themeOptions: Array.from(document.querySelectorAll("[data-theme-option]")),
};

async function init() {
  bindEvents();
  initialiseControls();
  applyTheme();
  applyColumnVisibility();
  await loadPresetDirectory();
  await attemptInitialLoad();
  updateSortIndicators();
}

function initialiseControls() {
  if (refs.pageSize) {
    refs.pageSize.value = String(state.pageSize);
  }
  if (refs.pageJump) {
    refs.pageJump.value = state.page > 0 ? state.page : 1;
  }
  if (refs.toggleRegex) {
    refs.toggleRegex.checked = state.regexSearch;
  }
  if (refs.toggleIncludeDirs) {
    refs.toggleIncludeDirs.checked = state.includeDirectories;
  }
  if (refs.toggleCaseSensitive) {
    refs.toggleCaseSensitive.checked = state.caseSensitive;
  }
  updateThemeOptions();
  refs.columnToggles.forEach((toggle) => {
    const key = toggle.dataset.columnToggle;
    if (key && key in state.visibleColumns) {
      toggle.checked = state.visibleColumns[key];
    }
  });
}

async function loadPresetDirectory() {
  try {
    const response = await fetch(PRESET_DIRECTORY, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`目录无法访问 (${response.status})`);
    }
    const text = await response.text();
    const files = extractEfuFromDirectoryListing(text, response.url);
    if (!files.length) return;
    state.manifest = files;
    populateManifestOptions(files);
  } catch (error) {
    console.info("目录枚举失败，将仅支持手动上传或默认文件", error);
  }
}

async function attemptInitialLoad() {
  if (state.manifest.length) {
    const preferred = findPreferredManifestItem();
    if (preferred) {
      refs.fileSelector.value = preferred.path;
      refs.loadSelected.disabled = false;
      await loadFileFromFetch(preferred.path, preferred.label);
      return;
    }
  }
  try {
    await loadFileFromFetch(DEFAULT_FILE, DEFAULT_FILE_NAME);
  } catch (error) {
    resetData();
    renderError("未能自动加载数据，请在上方选择或上传 .efu 文件。");
    setActiveSource("等待加载");
  }
}

function findPreferredManifestItem() {
  const exact = state.manifest.find((item) => item.path.toLowerCase().endsWith(DEFAULT_FILE_NAME.toLowerCase()));
  return exact || state.manifest[0] || null;
}

function extractEfuFromDirectoryListing(html, baseUrl) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const anchors = Array.from(doc.querySelectorAll("a[href]"));
    const items = anchors
      .map((anchor) => {
        const href = anchor.getAttribute("href");
        if (!href || !/\.efu$/i.test(href)) return null;
        const absolute = new URL(href, baseUrl);
        const label = anchor.textContent?.trim() || decodeURIComponent(absolute.pathname.split("/").pop() || href);
        return {
          label,
          path: normaliseLocalUrl(absolute),
        };
      })
      .filter(Boolean);
    const seen = new Set();
    return items.filter((item) => {
      if (seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    });
  } catch (error) {
    console.warn("目录解析失败", error);
    return [];
  }
}

function normaliseLocalUrl(url) {
  try {
    const absolute = typeof url === "string" ? new URL(url, window.location.href) : url;
    if (absolute.origin === window.location.origin) {
      return decodeURIComponent(absolute.pathname + absolute.search);
    }
    return absolute.toString();
  } catch (error) {
    return url.toString();
  }
}

function populateManifestOptions(files) {
  if (!refs.fileSelector) return;
  while (refs.fileSelector.options.length > 1) {
    refs.fileSelector.remove(1);
  }
  files.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.path;
    option.textContent = item.label || item.path;
    refs.fileSelector.appendChild(option);
  });
  if (files.length) {
    refs.loadSelected.disabled = true;
  }
}

async function loadFileFromFetch(path, label) {
  showLoader(true);
  try {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`无法加载 ${path} (${response.status})`);
    }
    const text = await response.text();
    ingestContent(text, {
      type: "remote",
      label: label || path,
      path,
    });
    if (refs.uploadName) {
      refs.uploadName.textContent = "尚未选择文件";
    }
    closePanels();
  } finally {
    showLoader(false);
  }
}

function ingestContent(text, sourceMeta) {
  const rows = parseCsv(text);
  const entries = rows
    .slice(1)
    .filter((row) => row.length >= 5)
    .map((row) => {
      const fullPath = row[0];
      const fileName = extractFileName(fullPath);
      const sizeRaw = row[1];
      const modifiedRaw = row[2];
      const createdRaw = row[3];
      const attributes = row[4];

      const sizeBig = safeBigInt(sizeRaw);
      const modifiedBig = safeBigInt(modifiedRaw);
      const createdBig = safeBigInt(createdRaw);
      const attributeNumber = safeNumber(attributes);
      const isDirectory = typeof attributeNumber === "number" && (attributeNumber & DIRECTORY_FLAG) === DIRECTORY_FLAG;

      const searchRaw = `${fullPath} ${fileName} ${attributes}`;

      return {
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
      };
    });

  state.entries = entries;
  state.filtered = entries.filter(filterDirectories);
  state.sortKey = "FileName";
  state.sortAsc = true;
  state.activeSource = sourceMeta;
  state.page = state.filtered.length ? 1 : 0;
  refs.searchInput.value = "";
  applySort();
  render();
  updateSortIndicators();
  setActiveSource(sourceMeta?.label || "未命名数据源");
}

function extractFileName(path) {
  if (!path) return "";
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function resetData() {
  state.entries = [];
  state.filtered = [];
  state.page = 0;
  updateMetrics();
  updatePaginationControls(0);
}

function parseCsv(text) {
  const rows = [];
  let current = [];
  let value = "";
  let insideQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === "\"") {
      if (insideQuotes && text[i + 1] === "\"") {
        value += "\"";
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
  if (value.length > 0 || current.length) {
    current.push(value);
    rows.push(current);
  }
  return rows;
}

function safeBigInt(raw) {
  try {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const big = BigInt(trimmed);
    return big >= 0n ? big : null;
  } catch (error) {
    return null;
  }
}

function safeNumber(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function formatSize(entry) {
  if (!entry.sizeBig) {
    return entry.sizeRaw || "—";
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = entry.sizeBig;
  let unitIndex = 0;
  const step = 1024n;
  while (value >= step && unitIndex < units.length - 1) {
    value = value / step;
    unitIndex += 1;
  }
  const remainder = entry.sizeBig * 1000n / (step ** BigInt(unitIndex));
  const display = Number(remainder) / 1000;
  const precision = display >= 100 ? 0 : display >= 10 ? 1 : 2;
  return `${display.toFixed(precision)} ${units[unitIndex]}`;
}

function filetimeToDate(rawBigInt) {
  if (!rawBigInt) return null;
  const diff = rawBigInt - WINDOWS_EPOCH_DIFFERENCE;
  if (diff <= 0n) return null;
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

function describeAttributes(raw) {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) {
    return trimmed;
  }
  if (numeric === 0) {
    return "无标记";
  }
  const labels = ATTRIBUTE_FLAGS
    .filter(({ mask }) => (numeric & mask) === mask)
    .map(({ label }) => label);
  if (!labels.length) {
    return trimmed;
  }
  return labels.join("，");
}

function render() {
  const rows = state.filtered;
  const totalPages = rows.length ? Math.ceil(rows.length / state.pageSize) : 0;

  if (totalPages === 0) {
    state.page = rows.length ? 1 : 0;
  } else {
    const clamped = Math.min(Math.max(state.page || 1, 1), totalPages);
    if (clamped !== state.page) {
      state.page = clamped;
    }
  }

  const pageItems = totalPages === 0 ? [] : rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);

  refs.results.textContent = "";

  if (!pageItems.length) {
    refs.results.innerHTML = "<tr><td colspan=6>未找到匹配的结果。</td></tr>";
    updateMetrics();
    updatePaginationControls(totalPages);
    renderSearchFeedback();
    applyColumnVisibility();
    return;
  }

  const chunkSize = Math.min(state.progressive ? 200 : pageItems.length, pageItems.length);
  const processChunk = (start) => {
    const fragment = document.createDocumentFragment();
    const end = state.progressive ? Math.min(start + chunkSize, pageItems.length) : pageItems.length;
    for (let i = start; i < end; i++) {
      const entry = pageItems[i];
      const tr = document.createElement("tr");
      tr.dataset.path = entry.path;
      tr.title = "双击复制路径";

      const nameTd = document.createElement("td");
      nameTd.className = `name-cell ${COLUMN_CLASSES.FileName}`;
      nameTd.textContent = entry.fileName || "(无文件名)";

      const pathTd = document.createElement("td");
      pathTd.className = `path-cell ${COLUMN_CLASSES.Path}`;
      pathTd.textContent = entry.path;

      const sizeTd = document.createElement("td");
      sizeTd.className = `${COLUMN_CLASSES.Size} num-cell`;
      const formattedSize = formatSize(entry);
      sizeTd.textContent = entry.isDirectory ? "—" : formattedSize;
      sizeTd.title = entry.isDirectory ? "" : formattedSize;

      const modifiedTd = document.createElement("td");
      modifiedTd.className = `date-cell ${COLUMN_CLASSES["Date Modified"]}`;
      const modified = formatFriendlyDate(entry, "Date Modified");
      if (modified.date === "—") {
        modifiedTd.textContent = "—";
      } else {
        modifiedTd.innerHTML = `<span>${modified.date}</span><span>${modified.time}</span>`;
        modifiedTd.title = modified.title;
      }
      if (!state.visibleColumns["Date Modified"]) {
        modifiedTd.classList.add("hidden-column");
      }

      const createdTd = document.createElement("td");
      createdTd.className = `date-cell ${COLUMN_CLASSES["Date Created"]}`;
      const created = formatFriendlyDate(entry, "Date Created");
      if (created.date === "—") {
        createdTd.textContent = "—";
      } else {
        createdTd.innerHTML = `<span>${created.date}</span><span>${created.time}</span>`;
        createdTd.title = created.title;
      }
      if (!state.visibleColumns["Date Created"]) {
        createdTd.classList.add("hidden-column");
      }

      const attrTd = document.createElement("td");
      attrTd.className = `attr-cell ${COLUMN_CLASSES.Attributes}`;
      attrTd.textContent = describeAttributes(entry.attributes);
      attrTd.title = entry.attributes || "";

      tr.append(nameTd, pathTd, sizeTd, modifiedTd, createdTd, attrTd);
      tr.addEventListener("dblclick", () => copyPath(entry.path));
      fragment.appendChild(tr);
    }
    refs.results.appendChild(fragment);
    applyColumnVisibility();
    if (state.progressive && end < pageItems.length) {
      requestAnimationFrame(() => processChunk(end));
    }
  };

  processChunk(0);
  updateMetrics();
  updatePaginationControls(totalPages);
  renderSearchFeedback();
}

function updateMetrics() {
  refs.totalCount.textContent = state.entries.length.toLocaleString();
  refs.filteredCount.textContent = state.filtered.length.toLocaleString();
  refs.filteredSize.textContent = formatAggregateSize(state.entries);
}

function updatePaginationControls(totalPages) {
  if (refs.currentPage) {
    refs.currentPage.textContent = totalPages === 0 ? 0 : state.page;
  }
  if (refs.totalPages) {
    refs.totalPages.textContent = totalPages;
  }
  if (refs.prevPage) {
    refs.prevPage.disabled = totalPages === 0 || state.page <= 1;
  }
  if (refs.nextPage) {
    refs.nextPage.disabled = totalPages === 0 || state.page >= totalPages;
  }
  if (refs.pageJump) {
    refs.pageJump.value = totalPages === 0 ? "" : state.page;
    refs.pageJump.disabled = totalPages === 0;
  }
}

function formatAggregateSize(list) {
  let sum = 0n;
  for (const item of list) {
    if (item.sizeBig && !item.isDirectory) {
      sum += item.sizeBig;
    }
  }
  if (sum === 0n) {
    return "—";
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = sum;
  let unitIndex = 0;
  const step = 1024n;
  while (value >= step && unitIndex < units.length - 1) {
    value = value / step;
    unitIndex += 1;
  }
  const remainder = sum * 1000n / (step ** BigInt(unitIndex));
  const display = Number(remainder) / 1000;
  const precision = display >= 100 ? 0 : display >= 10 ? 1 : 2;
  return `${display.toFixed(precision)} ${units[unitIndex]}`;
}

function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function debounce(fn, delay = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function applySearch(term) {
  const input = term ?? "";
  const trimmed = input.trim();
  state.regexError = null;

  if (!trimmed) {
    state.filtered = state.entries.filter(filterDirectories);
    state.page = state.filtered.length ? 1 : 0;
    applySort();
    render();
    return;
  }

  const plan = buildSearchPlan(trimmed, state.regexSearch, state.caseSensitive);
  if (plan.error) {
    state.filtered = [];
    state.regexError = plan.error;
    state.page = 0;
    render();
    return;
  }

  state.filtered = state.entries.filter((entry) => filterDirectories(entry) && matchTokens(entry, plan.tokens));
  state.page = state.filtered.length ? 1 : 0;
  applySort();
  render();
}

function filterDirectories(entry) {
  return state.includeDirectories ? true : !entry.isDirectory;
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
  const regex = regexMode ? buildEverythingRegex(token, caseSensitive) : buildWildcardRegex(token, caseSensitive);
  return {
    negate,
    field,
    regex,
  };
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
  const flags = caseSensitive ? "" : "i";
  return new RegExp(regexStr, flags);
}

function escapeRegexChar(char) {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
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

function getTokenTarget(entry, field) {
  if (field === "file") return entry.fileName || "";
  if (field === "path") return entry.path || "";
  return entry.searchRaw;
}

function applySort(key = state.sortKey) {
  state.sortKey = key;
  const multiplier = state.sortAsc ? 1 : -1;
  const collator = new Intl.Collator("zh-CN", { sensitivity: "base", numeric: true });
  const compare = {
    FileName: (a, b) => collator.compare(a.fileName, b.fileName),
    Path: (a, b) => collator.compare(a.path, b.path),
    Size: (a, b) => compareBigInt(a.sizeBig, b.sizeBig),
    "Date Modified": (a, b) => compareBigInt(a.modifiedBig, b.modifiedBig),
    "Date Created": (a, b) => compareBigInt(a.createdBig, b.createdBig),
    Attributes: (a, b) => collator.compare(describeAttributes(a.attributes), describeAttributes(b.attributes)),
  }[key];

  if (!compare) return;
  state.filtered.sort((a, b) => compare(a, b) * multiplier);
}

function compareBigInt(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (a > b) return 1;
  if (a < b) return -1;
  return 0;
}

function handleSortClick(event) {
  const key = event.target.dataset.sort;
  if (!key) return;
  if (state.sortKey === key) {
    state.sortAsc = !state.sortAsc;
  } else {
    state.sortKey = key;
    state.sortAsc = true;
  }
  applySort(key);
  render();
  updateSortIndicators();
}

function updateSortIndicators() {
  refs.headers.forEach((header) => {
    const key = header.dataset.sort;
    if (!key) return;
    header.dataset.direction = "";
    header.style.color = "inherit";
    if (key === state.sortKey) {
      header.dataset.direction = state.sortAsc ? "asc" : "desc";
      header.style.color = "var(--accent)";
    }
  });
}

function showLoader(visible) {
  refs.loader.classList.toggle("hidden", !visible);
}

function renderError(message) {
  refs.results.innerHTML = `<tr><td colspan="6">${escapeHtml(message)}</td></tr>`;
  updateMetrics();
  updatePaginationControls(0);
  renderSearchFeedback();
  applyColumnVisibility();
}

async function copyPath(path) {
  try {
    await navigator.clipboard.writeText(path);
  } catch (err) {
    console.warn("复制失败", err);
  }
}

function setActiveSource(label) {
  const text = label || "—";
  refs.activeSource.textContent = text;
  if (refs.footerSource) {
    refs.footerSource.textContent = text;
  }
}

function renderSearchFeedback() {
  if (!refs.searchError) return;
  if (state.regexError) {
    refs.searchError.textContent = state.regexError;
    refs.searchError.classList.remove("hidden");
  } else {
    refs.searchError.textContent = "";
    refs.searchError.classList.add("hidden");
  }
}

function applyTheme() {
  const meta = THEME_META[state.theme] || THEME_META.light;
  const root = document.documentElement;
  root.classList.remove("theme-light", "theme-dark", "theme-mac");
  if (meta.className) {
    root.classList.add(meta.className);
  }
  try {
    localStorage.setItem("efu-theme", state.theme);
  } catch (error) {
    // 忽略存储失败
  }
  updateThemeOptions();
}

function updateThemeOptions() {
  if (!refs.themeOptions) return;
  const meta = THEME_META[state.theme] || THEME_META.light;
  refs.themeOptions.forEach((button) => {
    const target = button.dataset.themeOption;
    const active = target === state.theme;
    button.classList.toggle("active", active);
    if (active) {
      button.setAttribute("aria-pressed", "true");
    } else {
      button.setAttribute("aria-pressed", "false");
    }
  });
  if (refs.openSettings) {
    refs.openSettings.setAttribute("aria-label", `打开设置（当前主题：${meta.label}）`);
  }
}

function cycleTheme() {
  const currentIndex = THEME_SEQUENCE.indexOf(state.theme);
  const nextTheme = THEME_SEQUENCE[(currentIndex + 1) % THEME_SEQUENCE.length];
  state.theme = nextTheme;
  applyTheme();
}

function openPanel(panel) {
  if (!panel) return;
  closePanels();
  if (refs.overlay) {
    refs.overlay.classList.remove("hidden");
  }
  panel.classList.remove("hidden");
}

function closePanels() {
  if (refs.overlay) {
    refs.overlay.classList.add("hidden");
  }
  [refs.sourcePanel, refs.settingsPanel].forEach((panel) => {
    if (panel) panel.classList.add("hidden");
  });
  closeColumnPopover();
}

function openColumnPopover() {
  if (!refs.columnPopover || !refs.columnSettingsToggle) return;
  refs.columnSettingsToggle.classList.add("active");
  refs.columnPopover.classList.remove("hidden");
}

function closeColumnPopover() {
  if (!refs.columnPopover || !refs.columnSettingsToggle) return;
  refs.columnPopover.classList.add("hidden");
  refs.columnSettingsToggle.classList.remove("active");
}

function toggleColumnPopover() {
  if (!refs.columnPopover || !refs.columnSettingsToggle) return;
  const isOpen = !refs.columnPopover.classList.contains("hidden");
  if (isOpen) {
    closeColumnPopover();
  } else {
    openColumnPopover();
  }
}

function applyColumnVisibility() {
  Object.entries(COLUMN_CLASSES).forEach(([key, className]) => {
    const visible = state.visibleColumns[key];
    document.querySelectorAll(`.${className}`).forEach((node) => {
      node.classList.toggle("hidden-column", !visible);
    });
  });
}

const debouncedSearch = debounce((event) => {
  applySearch(event.target.value || "");
}, 250);

function bindEvents() {
  refs.searchInput.addEventListener("input", debouncedSearch);
  if (refs.clearSearch) {
    refs.clearSearch.addEventListener("click", () => {
      refs.searchInput.value = "";
      applySearch("");
    });
  }
  refs.headers.forEach((header) => header.addEventListener("click", handleSortClick));
  if (refs.fileSelector) {
    refs.fileSelector.addEventListener("change", (event) => {
      const hasValue = Boolean(event.target.value);
      if (refs.loadSelected) {
        refs.loadSelected.disabled = !hasValue;
      }
    });
  }
  if (refs.loadSelected) {
    refs.loadSelected.addEventListener("click", async () => {
      const option = refs.fileSelector?.selectedOptions[0];
      if (!option || !option.value) return;
      try {
        await loadFileFromFetch(option.value, option.textContent.trim());
        setActiveSource(option.textContent.trim());
      } catch (error) {
        resetData();
        renderError(error.message);
      }
    });
  }
  if (refs.uploadTrigger) {
    refs.uploadTrigger.addEventListener("click", () => {
      refs.fileUpload?.click();
    });
  }
  if (refs.openSource) {
    refs.openSource.addEventListener("click", () => {
      openPanel(refs.sourcePanel);
    });
  }
  if (refs.closeSource) {
    refs.closeSource.addEventListener("click", closePanels);
  }
  if (refs.openSettings) {
    refs.openSettings.addEventListener("click", () => {
      openPanel(refs.settingsPanel);
      updateThemeOptions();
    });
  }
  if (refs.closeSettings) {
    refs.closeSettings.addEventListener("click", closePanels);
  }
  if (refs.overlay) {
    refs.overlay.addEventListener("click", closePanels);
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePanels();
    }
  });
  if (refs.toggleRegex) {
    refs.toggleRegex.addEventListener("change", (event) => {
      state.regexSearch = event.target.checked;
      applySearch(refs.searchInput.value || "");
    });
  }
  if (refs.toggleIncludeDirs) {
    refs.toggleIncludeDirs.addEventListener("change", (event) => {
      state.includeDirectories = event.target.checked;
      applySearch(refs.searchInput.value || "");
    });
  }
  if (refs.toggleCaseSensitive) {
    refs.toggleCaseSensitive.addEventListener("change", (event) => {
      state.caseSensitive = event.target.checked;
      applySearch(refs.searchInput.value || "");
    });
  }
  if (refs.columnSettingsToggle) {
    refs.columnSettingsToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleColumnPopover();
    });
  }
  if (refs.columnPopover) {
    refs.columnPopover.addEventListener("click", (event) => event.stopPropagation());
  }
  refs.themeOptions.forEach((button) =>
    button.addEventListener("click", () => {
      const theme = button.dataset.themeOption;
      if (!theme || !THEME_SEQUENCE.includes(theme)) return;
      state.theme = theme;
      applyTheme();
    })
  );
  document.addEventListener("click", (event) => {
    if (!refs.columnPopover || !refs.columnSettingsToggle) return;
    const withinPopover = refs.columnPopover.contains(event.target);
    const withinToggle = refs.columnSettingsToggle.contains(event.target);
    if (!withinPopover && !withinToggle) {
      closeColumnPopover();
    }
  });
  if (refs.pageSize) {
    refs.pageSize.addEventListener("change", (event) => {
      const value = Number(event.target.value);
      if (!Number.isFinite(value) || value <= 0) {
        event.target.value = state.pageSize;
        return;
      }
      state.pageSize = value;
      state.page = state.filtered.length ? 1 : 0;
      render();
    });
  }
  if (refs.prevPage) {
    refs.prevPage.addEventListener("click", () => {
      if (state.page > 1) {
        state.page -= 1;
        render();
      }
    });
  }
  if (refs.nextPage) {
    refs.nextPage.addEventListener("click", () => {
      const totalPages = state.filtered.length ? Math.ceil(state.filtered.length / state.pageSize) : 0;
      if (totalPages && state.page < totalPages) {
        state.page += 1;
        render();
      }
    });
  }
  if (refs.pageJump) {
    refs.pageJump.addEventListener("change", (event) => {
      const totalPages = state.filtered.length ? Math.ceil(state.filtered.length / state.pageSize) : 0;
      if (!totalPages) {
        event.target.value = "";
        return;
      }
      const value = Number(event.target.value);
      if (!Number.isFinite(value) || value < 1) {
        event.target.value = state.page;
        return;
      }
      const target = Math.min(Math.floor(value), totalPages);
      state.page = target;
      render();
    });
  }
  refs.columnToggles.forEach((toggle) =>
    toggle.addEventListener("change", (event) => {
      const key = event.target.dataset.columnToggle;
      if (!key || !(key in state.visibleColumns)) return;
      state.visibleColumns[key] = event.target.checked;
      applyColumnVisibility();
      render();
    })
  );
}
function handleFileUpload(event) {
  const [file] = event.target.files || [];
  if (!file) return;
  refs.fileSelector.value = "";
  refs.loadSelected.disabled = true;
  refs.uploadName.textContent = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      ingestContent(reader.result, {
        type: "upload",
        label: file.name,
      });
      if (refs.uploadName) {
        refs.uploadName.textContent = file.name;
      }
      closePanels();
    } catch (error) {
      resetData();
      renderError("上传的文件解析失败");
    }
  };
  reader.onerror = () => {
    resetData();
    renderError("读取本地文件失败");
  };
  reader.readAsText(file);
}

init();
