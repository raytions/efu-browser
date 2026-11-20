const Core = typeof window !== "undefined" ? window.EfuCore : null;
const ScansDemoService = typeof window !== "undefined" ? window.EfuScansDemoService : null;
const ScansRealService = typeof window !== "undefined" ? window.EfuScansRealService : null;
const ScansView = typeof window !== "undefined" ? window.EfuScansView : null;

const RUNTIME_CONFIG_FILE = "config.json";
const DEFAULT_PAGE_SIZE = 20;
const CACHE_STORAGE_KEY = "efu-cached-data-v2";
const CACHE_MAX_BYTES = 2 * 1024 * 1024;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const COLUMN_CLASSES = {
  FileName: "col-file",
  Path: "col-path",
  Size: "col-size",
  "Date Modified": "col-modified",
  "Date Created": "col-created",
  Attributes: "col-attributes",
};

const THEME_SEQUENCE = ["system", "light", "dark"];
const THEME_META = {
  system: { label: "跟随系统" },
  light: { label: "亮色" },
  dark: { label: "暗黑" },
};

function getSystemPrefersDark() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function resolveInitialTheme() {
  try {
    const stored = localStorage.getItem("efu-theme");
    if (stored && THEME_SEQUENCE.includes(stored)) {
      return stored;
    }
  } catch {
    // 忽略存储异常
  }
  return "system";
}

const state = {
  currentRoute: "browser",
  scansMode: "demo",
  scansApiBase: null,
  entries: [],
  filtered: [],
  sortKey: "FileName",
  sortAsc: true,
  serverIndexes: [],
  defaultServerIndexId: null,
  selectedServerIndexId: null,
  activeSource: null,
  activeLoadId: 0,
  activeAbortController: null,
  demoSuggestedSearch: null,
  regexSearch: false,
  regexError: null,
  pageSize: DEFAULT_PAGE_SIZE,
  page: 0,
  includeDirectories: true,
  caseSensitive: false,
  theme: resolveInitialTheme(),
  progressive: true,
  localUploads: Object.create(null),
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
  browserView: document.getElementById("browser-view"),
  scansView: document.getElementById("scans-view"),
  navBrowser: document.getElementById("nav-browser"),
  navScans: document.getElementById("nav-scans"),
  navScansPill: document.getElementById("nav-scans-pill"),
  routeLinks: Array.from(document.querySelectorAll("[data-route]")),
  demoHintBanner: document.getElementById("demo-hint-banner"),
  demoHintText: document.getElementById("demo-hint-text"),
  demoHintApply: document.getElementById("demo-hint-apply"),
  demoHintDismiss: document.getElementById("demo-hint-dismiss"),
  totalCount: document.getElementById("total-count"),
  filteredCount: document.getElementById("filtered-count"),
  filteredSize: document.getElementById("filtered-size"),
  results: document.getElementById("results"),
  searchInput: document.getElementById("search-input"),
  searchError: document.getElementById("search-error"),
  clearSearch: document.getElementById("clear-search"),
  loader: document.getElementById("loader"),
  loaderText: document.getElementById("loader-text"),
  tableWrapper: document.getElementById("table-wrapper"),
  headers: Array.from(document.querySelectorAll("thead th")),
  activeSource: document.getElementById("active-source"),
  snapshotModified: document.getElementById("snapshot-modified"),
  footerSource: document.getElementById("footer-source"),
  serverIndexBar: document.getElementById("server-index-bar"),
  serverIndexSelect: document.getElementById("server-index-select"),
  reloadServerIndex: document.getElementById("reload-server-index"),
  serverIndexStatus: document.getElementById("server-index-status"),
  serverSourceBlock: document.getElementById("server-source-block"),
  statusBanner: document.getElementById("status-banner"),
  statusBannerText: document.getElementById("status-banner-text"),
  statusBannerDismiss: document.getElementById("status-banner-dismiss"),
  fileSelector: document.getElementById("file-selector"),
  loadSelected: document.getElementById("load-selected"),
  fileUpload: document.getElementById("file-upload"),
  uploadTrigger: document.getElementById("upload-trigger"),
  toggleRegex: document.getElementById("toggle-regex"),
  toggleIncludeDirs: document.getElementById("toggle-include-dirs"),
  toggleCaseSensitive: document.getElementById("toggle-case-sensitive"),
  uploadName: document.getElementById("upload-name"),
  openSource: document.getElementById("open-source"),
  closeCurrent: document.getElementById("close-current"),
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
  uploadProgress: document.getElementById("upload-progress"),
  uploadProgressBar: document.getElementById("upload-progress-bar"),
  uploadProgressText: document.getElementById("upload-progress-text"),
  copyToast: document.getElementById("copy-toast"),
};

let copyToastTimer = null;
let scansServiceInstance = null;
let scansViewInstance = null;

function resolveRouteFromLocation() {
  if (typeof window === "undefined") return "browser";
  const rawHash = (window.location.hash || "").replace(/^#/, "").trim().toLowerCase();
  const normalizedHash = rawHash.replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalizedHash === "scans") {
    return "scans";
  }
  if (normalizedHash === "browser") {
    return "browser";
  }
  try {
    const params = new URLSearchParams(window.location.search);
    if ((params.get("view") || "").toLowerCase() === "scans") {
      return "scans";
    }
  } catch {
    // 忽略查询参数解析异常
  }
  return "browser";
}

function navigateTo(route, { updateHash = true } = {}) {
  const targetRoute = route === "scans" ? "scans" : "browser";
  state.currentRoute = targetRoute;

  if (refs.browserView) {
    refs.browserView.classList.toggle("hidden", targetRoute !== "browser");
  }
  if (refs.scansView) {
    refs.scansView.classList.toggle("hidden", targetRoute !== "scans");
  }
  if (refs.navBrowser) {
    const active = targetRoute === "browser";
    refs.navBrowser.classList.toggle("active", active);
    if (active) refs.navBrowser.setAttribute("aria-current", "page");
    else refs.navBrowser.removeAttribute("aria-current");
  }
  if (refs.navScans) {
    const active = targetRoute === "scans";
    refs.navScans.classList.toggle("active", active);
    if (active) refs.navScans.setAttribute("aria-current", "page");
    else refs.navScans.removeAttribute("aria-current");
  }

  if (updateHash && typeof window !== "undefined") {
    const desiredHash = targetRoute === "scans" ? "#/scans" : "#/browser";
    if (window.location.hash !== desiredHash) {
      window.location.hash = desiredHash;
    }
  }

  if (
    targetRoute === "scans" &&
    scansServiceInstance &&
    !scansServiceInstance.isDemo &&
    typeof scansServiceInstance.refresh === "function"
  ) {
    scansServiceInstance.refresh({ silent: scansServiceInstance.listJobs().length > 0 });
  }
}

function updateScansModeBadge() {
  if (!refs.navScansPill) return;
  if (state.scansMode === "real") {
    refs.navScansPill.textContent = "真实";
    refs.navScansPill.classList.add("nav-real-pill");
  } else {
    refs.navScansPill.textContent = "演示";
    refs.navScansPill.classList.remove("nav-real-pill");
  }
}

function initScansSection() {
  if (!refs.scansView || !ScansView) return;

  if (scansViewInstance) {
    scansViewInstance.destroy();
    scansViewInstance = null;
  }
  if (scansServiceInstance && typeof scansServiceInstance.dispose === "function") {
    scansServiceInstance.dispose();
    scansServiceInstance = null;
  }

  updateScansModeBadge();

  if (state.scansMode === "real" && ScansRealService) {
    const realOptions =
      typeof window !== "undefined" && window.EFU_SCANS_REAL_OPTIONS
        ? window.EFU_SCANS_REAL_OPTIONS
        : {};
    scansServiceInstance = ScansRealService.createRealScansService({
      apiBase: state.scansApiBase || "/api/scans",
      ...realOptions,
    });
    scansViewInstance = ScansView.createScansView({
      container: refs.scansView,
      service: scansServiceInstance,
      onOpenResult: (payload) => {
        openScanResult(payload);
      },
    });
    if (state.currentRoute === "scans") {
      scansServiceInstance.refresh();
    }
    return;
  }

  if (!ScansDemoService) return;
  const demoOptions =
    typeof window !== "undefined" && window.EFU_SCANS_DEMO_OPTIONS
      ? window.EFU_SCANS_DEMO_OPTIONS
      : undefined;
  scansServiceInstance = ScansDemoService.createDemoScansService(demoOptions);
  scansViewInstance = ScansView.createScansView({
    container: refs.scansView,
    service: scansServiceInstance,
    onOpenResult: (payload) => {
      openScanResult(payload);
    },
  });
}

async function init() {
  bindEvents();
  initialiseControls();
  applyTheme();
  navigateTo(resolveRouteFromLocation(), { updateHash: false });

  await new Promise((resolve) => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", resolve, { once: true });
    } else {
      resolve();
    }
  });

  applyColumnVisibility();
  render();
  updateSortIndicators();

  await loadRuntimeConfig();
  initScansSection();

  if (state.serverIndexes.length > 0) {
    const initialId = state.defaultServerIndexId || state.serverIndexes[0].id;
    syncServerIndexSelectors(initialId);
    await loadServerIndex(initialId);
  } else {
    // 静态部署 / 无服务器索引配置时：不请求任何 EFU，仅恢复本地缓存或等待手动导入
    loadCachedData();
  }
}

function initialiseControls() {
  if (refs.pageSize) {
    refs.pageSize.value = String(state.pageSize);
  }
  if (refs.pageJump) {
    refs.pageJump.value = state.page > 0 ? state.page : "";
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

async function loadRuntimeConfig() {
  let rawConfig = null;
  const baseHref = window.location.href;

  if (typeof window !== "undefined" && window.EFU_BROWSER_CONFIG && typeof window.EFU_BROWSER_CONFIG === "object") {
    rawConfig = window.EFU_BROWSER_CONFIG;
  } else if (window.location.protocol === "http:" || window.location.protocol === "https:") {
    try {
      const configUrl = new URL(RUNTIME_CONFIG_FILE, baseHref).href;
      const response = await fetch(configUrl, { cache: "no-store" });
      if (response.status === 404) {
        return;
      }
      if (!response.ok) {
        showStatusBanner(`无法读取服务器索引配置 (${response.status})，仍可手动导入本地 EFU 文件。`);
        return;
      }
      rawConfig = await response.json();
    } catch (error) {
      console.warn("读取运行时配置失败", error);
      showStatusBanner("服务器索引配置解析失败，仍可手动导入本地 EFU 文件。");
      return;
    }
  } else {
    return;
  }

  const normalized = Core.normalizeRuntimeConfig(rawConfig, baseHref);
  if (normalized.warnings.length > 0) {
    console.warn("服务器索引配置警告：", normalized.warnings);
  }

  state.serverIndexes = normalized.indexes;
  state.defaultServerIndexId = normalized.defaultIndex;
  state.scansMode = normalized.scans?.mode === "real" ? "real" : "demo";
  state.scansApiBase = normalized.scans?.apiBase || null;
  renderServerIndexControls();
}

function renderServerIndexControls() {
  const indexes = state.serverIndexes;
  const hasIndexes = indexes.length > 0;

  if (refs.serverIndexBar) {
    refs.serverIndexBar.classList.toggle("hidden", !hasIndexes);
  }
  if (refs.serverSourceBlock) {
    refs.serverSourceBlock.classList.toggle("hidden", !hasIndexes);
  }

  if (refs.serverIndexSelect) {
    refs.serverIndexSelect.textContent = "";
    indexes.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      refs.serverIndexSelect.appendChild(option);
    });
  }

  if (refs.fileSelector) {
    while (refs.fileSelector.options.length > 1) {
      refs.fileSelector.remove(1);
    }
    indexes.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      refs.fileSelector.appendChild(option);
    });
    if (refs.loadSelected) {
      refs.loadSelected.disabled = !refs.fileSelector.value;
    }
  }
}

function syncServerIndexSelectors(indexId) {
  state.selectedServerIndexId = indexId || null;
  if (refs.serverIndexSelect && indexId) {
    refs.serverIndexSelect.value = indexId;
  }
  if (refs.fileSelector) {
    refs.fileSelector.value = indexId || "";
    if (refs.loadSelected) {
      refs.loadSelected.disabled = !refs.fileSelector.value;
    }
  }
}

function setServerLoadingStatus(text) {
  if (!refs.serverIndexStatus) return;
  if (text) {
    refs.serverIndexStatus.textContent = text;
    refs.serverIndexStatus.classList.remove("hidden");
  } else {
    refs.serverIndexStatus.textContent = "";
    refs.serverIndexStatus.classList.add("hidden");
  }
}

function showStatusBanner(message) {
  if (!refs.statusBanner || !refs.statusBannerText) return;
  refs.statusBannerText.textContent = message;
  refs.statusBanner.classList.remove("hidden");
}

function hideStatusBanner() {
  if (!refs.statusBanner || !refs.statusBannerText) return;
  refs.statusBannerText.textContent = "";
  refs.statusBanner.classList.add("hidden");
}

function showDemoHintBanner(label, suggestedSearch) {
  state.demoSuggestedSearch = suggestedSearch || null;
  if (!refs.demoHintBanner || !refs.demoHintText) return;
  if (suggestedSearch) {
    refs.demoHintText.textContent = `已加载「${label}」，建议搜索 ${suggestedSearch} 查看本次模拟扫描新增的文件。`;
    if (refs.demoHintApply) {
      refs.demoHintApply.textContent = `搜索 ${suggestedSearch}`;
      refs.demoHintApply.classList.remove("hidden");
    }
  } else {
    refs.demoHintText.textContent = `已加载「${label}」（虚构演示数据，不涉及真实设备或 NAS）。`;
    if (refs.demoHintApply) {
      refs.demoHintApply.classList.add("hidden");
    }
  }
  refs.demoHintBanner.classList.remove("hidden");
}

function hideDemoHintBanner() {
  state.demoSuggestedSearch = null;
  if (!refs.demoHintBanner || !refs.demoHintText) return;
  refs.demoHintText.textContent = "";
  refs.demoHintBanner.classList.add("hidden");
}

async function loadRemoteEfu({
  url,
  displayPath,
  label,
  type = "server",
  id = null,
  isReload = false,
  suggestedSearch = null,
}) {
  // 竞态保护：每次加载分配递增 ID 并中止前一个在途请求
  const loadId = ++state.activeLoadId;
  if (state.activeAbortController) {
    try {
      state.activeAbortController.abort();
    } catch {
      // 忽略中止异常
    }
  }
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  state.activeAbortController = controller;

  if (type === "server" && id) {
    syncServerIndexSelectors(id);
  }
  hideStatusBanner();
  showLoader(true, `${isReload ? "正在重新加载" : "正在加载"}「${label}」...`);
  if (type === "server") {
    setServerLoadingStatus(isReload ? "正在刷新快照..." : "正在加载...");
    if (refs.reloadServerIndex) {
      refs.reloadServerIndex.disabled = true;
    }
  }

  try {
    const fetchOptions = { cache: "no-store" };
    if (controller) {
      fetchOptions.signal = controller.signal;
    }

    const response = await fetch(url, fetchOptions);
    if (loadId !== state.activeLoadId) {
      return false;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim());
    }

    const text = await response.text();
    if (loadId !== state.activeLoadId) {
      return false;
    }

    const lastModifiedHeader = response.headers ? response.headers.get("Last-Modified") : null;
    const snapshotModified = type === "demo" ? null : Core.formatHttpTimestamp(lastModifiedHeader);

    // 解析与提交统一走 ingestContent；若解析抛错则不会覆盖旧状态
    ingestContent(text, {
      type,
      id,
      label,
      path: displayPath || url,
      url,
      snapshotModified,
    });

    if (type === "demo") {
      showDemoHintBanner(label, suggestedSearch);
    } else {
      hideDemoHintBanner();
    }

    if (refs.uploadName) {
      refs.uploadName.textContent = "选择本地 .efu 文件进行浏览";
    }
    closePanels();
    return true;
  } catch (error) {
    if (loadId !== state.activeLoadId) {
      return false;
    }
    if (error && error.name === "AbortError") {
      return false;
    }

    // 加载或解析失败：保留现有已加载的结果，只显示可读错误提示
    const detail = error && error.message ? error.message : "网络或解析异常";
    const keepHint = state.activeSource ? "（已保留当前显示结果）" : "";
    showStatusBanner(`加载索引「${label}」失败：${detail}${keepHint}`);

    // 若当前已有其他服务器索引在展示，保持状态清晰
    if (state.activeSource && state.activeSource.type === "server" && state.activeSource.id) {
      syncServerIndexSelectors(state.activeSource.id);
    }
    return false;
  } finally {
    if (loadId === state.activeLoadId) {
      state.activeAbortController = null;
      showLoader(false);
      setServerLoadingStatus("");
      if (refs.reloadServerIndex) {
        refs.reloadServerIndex.disabled = false;
      }
    }
  }
}

async function loadServerIndex(indexId, { isReload = false } = {}) {
  const target = state.serverIndexes.find((item) => item.id === indexId);
  if (!target) {
    showStatusBanner("未找到指定的服务器索引配置。");
    return false;
  }
  return loadRemoteEfu({
    url: target.url,
    displayPath: target.displayPath,
    label: target.name,
    type: "server",
    id: target.id,
    isReload,
  });
}

async function openScanResult({ type = "demo", jobId = null, url, label, suggestedSearch = null } = {}) {
  const resolved = Core.resolveSameOriginUrl(url, window.location.href);
  if (!resolved.ok) {
    navigateTo("browser");
    showStatusBanner(`无法打开扫描结果：${resolved.error}`);
    return false;
  }
  navigateTo("browser");
  const sourceType = type === "real" ? "server" : "demo";
  const matchedServerIndex =
    sourceType === "server"
      ? state.serverIndexes.find(
          (item) =>
            item.id === jobId ||
            item.url === resolved.url ||
            item.displayPath === resolved.displayPath
        )
      : null;

  return loadRemoteEfu({
    url: resolved.url,
    displayPath: resolved.displayPath,
    label: label || (sourceType === "server" ? "服务器快照" : "演示快照"),
    type: sourceType,
    id: matchedServerIndex ? matchedServerIndex.id : null,
    isReload: false,
    suggestedSearch: sourceType === "demo" ? suggestedSearch : null,
  });
}

async function openDemoResult(payload) {
  return openScanResult({ ...payload, type: "demo" });
}

function ingestContent(text, sourceMeta) {
  // 先完整解析并校验，成功后再原子替换应用状态（避免失败时清空旧数据）
  const parsed = Core.parseEfu(text);

  state.entries = parsed.entries;
  state.sortKey = "FileName";
  state.sortAsc = true;
  state.activeSource = sourceMeta;
  state.regexError = null;
  if (refs.searchInput) {
    refs.searchInput.value = "";
  }

  const { filtered } = Core.filterAndSortEntries(state.entries, {
    query: "",
    regexSearch: state.regexSearch,
    caseSensitive: state.caseSensitive,
    includeDirectories: state.includeDirectories,
    sortKey: state.sortKey,
    sortAsc: state.sortAsc,
  });

  state.filtered = filtered;
  state.page = state.filtered.length ? 1 : 0;

  hideStatusBanner();
  if (!sourceMeta || sourceMeta.type !== "demo") {
    hideDemoHintBanner();
  }
  render();
  updateSortIndicators();
  setActiveSource(sourceMeta);

  // 仅缓存本地手动导入的小型快照；服务器索引与演示快照不写入本地缓存
  if (sourceMeta && (sourceMeta.type === "local" || sourceMeta.type === "upload")) {
    saveCachedData();
  }
}

function resetData() {
  state.entries = [];
  state.filtered = [];
  state.page = 0;
  state.regexError = null;
  updateMetrics();
  updatePaginationControls(0);
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

  const pageItems =
    totalPages === 0
      ? []
      : rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);

  refs.results.textContent = "";

  if (!pageItems.length) {
    if (refs.tableWrapper) {
      refs.tableWrapper.classList.add("empty");
    }

    const hasSource = Boolean(state.activeSource);
    const hasAnyEntries = state.entries.length > 0;

    let emptyTitle = "尚未加载数据";
    let emptyHint = "点击此处或上方“数据源”按钮，打开本地 .efu 文件开始浏览。";
    if (hasAnyEntries) {
      emptyTitle = "未找到匹配的结果";
      emptyHint = "试试调整搜索关键字、通配符或关闭大小写敏感。";
    } else if (hasSource) {
      emptyTitle = "该快照不包含文件条目";
      emptyHint = "目标目录当前为空，或所有目录已被排除。";
    }

    const tr = document.createElement("tr");
    tr.className = "empty-row";
    const td = document.createElement("td");
    td.colSpan = 6;

    const box = document.createElement("div");
    box.className = "empty-state";
    box.dataset.action = hasSource ? "none" : "open-local";

    const iconSpan = document.createElement("span");
    iconSpan.className = "empty-icon";
    iconSpan.setAttribute("aria-hidden", "true");
    iconSpan.innerHTML =
      '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';

    const heading = document.createElement("h3");
    heading.textContent = emptyTitle;

    const desc = document.createElement("p");
    desc.textContent = emptyHint;

    box.append(iconSpan, heading, desc);
    td.appendChild(box);
    tr.appendChild(td);
    refs.results.appendChild(tr);

    document.body.classList.toggle("empty-data-state", !hasAnyEntries);

    updateMetrics();
    updatePaginationControls(totalPages);
    renderSearchFeedback();
    applyColumnVisibility();
    return;
  }

  if (refs.tableWrapper) {
    refs.tableWrapper.classList.remove("empty");
  }
  document.body.classList.remove("empty-data-state");

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
      nameTd.dataset.label = "文件名";

      const pathTd = document.createElement("td");
      pathTd.className = `path-cell ${COLUMN_CLASSES.Path}`;
      pathTd.textContent = entry.path;
      pathTd.dataset.label = "路径";

      const sizeTd = document.createElement("td");
      sizeTd.className = `${COLUMN_CLASSES.Size} num-cell`;
      const formattedSize = Core.formatSize(entry);
      sizeTd.textContent = formattedSize;
      sizeTd.title = formattedSize === "—" ? "" : formattedSize;
      sizeTd.dataset.label = "大小";

      const modifiedTd = document.createElement("td");
      modifiedTd.className = `date-cell ${COLUMN_CLASSES["Date Modified"]}`;
      const modified = Core.formatFriendlyDate(entry, "Date Modified");
      renderDateCell(modifiedTd, modified);
      modifiedTd.dataset.label = "修改时间";

      const createdTd = document.createElement("td");
      createdTd.className = `date-cell ${COLUMN_CLASSES["Date Created"]}`;
      const created = Core.formatFriendlyDate(entry, "Date Created");
      renderDateCell(createdTd, created);
      createdTd.dataset.label = "创建时间";

      const attrTd = document.createElement("td");
      attrTd.className = `attr-cell ${COLUMN_CLASSES.Attributes}`;
      attrTd.textContent = Core.describeAttributes(entry.attributes);
      attrTd.title = entry.attributes || "";
      attrTd.dataset.label = "属性";

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

function renderDateCell(td, formatted) {
  td.textContent = "";
  if (formatted.date === "—") {
    td.textContent = "—";
    td.title = "";
    return;
  }
  const dateSpan = document.createElement("span");
  dateSpan.className = "date-day";
  dateSpan.textContent = formatted.date;

  const timeSpan = document.createElement("span");
  timeSpan.className = "date-time";
  timeSpan.textContent = formatted.time;

  td.append(dateSpan, timeSpan);
  td.title = formatted.title;
}

function updateMetrics() {
  refs.totalCount.textContent = state.activeSource ? state.entries.length.toLocaleString() : "—";
  refs.filteredCount.textContent = state.activeSource ? state.filtered.length.toLocaleString() : "—";
  refs.filteredSize.textContent = state.activeSource ? Core.formatAggregateSize(state.filtered) : "—";
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

function debounce(fn, delay = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function applySearch(term) {
  const { filtered, regexError } = Core.filterAndSortEntries(state.entries, {
    query: term ?? "",
    regexSearch: state.regexSearch,
    caseSensitive: state.caseSensitive,
    includeDirectories: state.includeDirectories,
    sortKey: state.sortKey,
    sortAsc: state.sortAsc,
  });

  state.regexError = regexError;
  state.filtered = filtered;
  state.page = state.filtered.length ? 1 : 0;
  render();
}

function applySort(key = state.sortKey) {
  state.sortKey = key;
  const { filtered } = Core.filterAndSortEntries(state.entries, {
    query: refs.searchInput ? refs.searchInput.value : "",
    regexSearch: state.regexSearch,
    caseSensitive: state.caseSensitive,
    includeDirectories: state.includeDirectories,
    sortKey: state.sortKey,
    sortAsc: state.sortAsc,
  });
  state.filtered = filtered;
}

function handleSortClick(event) {
  const header = event.target.closest("th[data-sort]");
  const key = header ? header.dataset.sort : null;
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
    header.style.color = "";
    if (key === state.sortKey) {
      header.dataset.direction = state.sortAsc ? "asc" : "desc";
      header.style.color = "var(--text-primary)";
    }
  });
}

function showLoader(visible, text) {
  if (!refs.loader) return;
  if (refs.loaderText && text) {
    refs.loaderText.textContent = text;
  }
  refs.loader.classList.toggle("hidden", !visible);
}

async function copyPath(pathText) {
  try {
    await navigator.clipboard.writeText(pathText);
    showCopyToast(`已复制路径：${pathText}`);
  } catch (err) {
    console.warn("复制失败", err);
    showCopyToast("复制失败，请检查剪贴板权限");
  }
}

function showCopyToast(message) {
  if (!refs.copyToast) return;
  refs.copyToast.textContent = message;
  refs.copyToast.classList.remove("hidden");
  clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => {
    refs.copyToast.classList.add("hidden");
  }, 2000);
}

function setActiveSource(sourceMeta) {
  const label = typeof sourceMeta === "string" ? sourceMeta : sourceMeta?.label;
  const text = label || "尚未加载";

  if (refs.activeSource) {
    refs.activeSource.textContent = text;
  }
  if (refs.footerSource) {
    refs.footerSource.textContent = label || "—";
  }

  if (refs.snapshotModified) {
    const snapshotTime = typeof sourceMeta === "object" ? sourceMeta?.snapshotModified : null;
    if (snapshotTime) {
      refs.snapshotModified.textContent = `快照修改时间：${snapshotTime}`;
      refs.snapshotModified.title = "来自服务器 HTTP Last-Modified 响应头";
      refs.snapshotModified.classList.remove("hidden");
    } else {
      refs.snapshotModified.textContent = "";
      refs.snapshotModified.classList.add("hidden");
    }
  }

  const hasFile = Boolean(label && label !== "等待加载" && label !== "—" && label !== "尚未加载");
  if (refs.closeCurrent) {
    refs.closeCurrent.style.display = hasFile ? "inline-flex" : "none";
  }
}

function serializeEntryForCache(entry) {
  return {
    path: entry.path,
    fileName: entry.fileName,
    sizeRaw: entry.sizeRaw,
    sizeBig: entry.sizeBig !== null && entry.sizeBig !== undefined ? entry.sizeBig.toString() : null,
    modifiedRaw: entry.modifiedRaw,
    modifiedBig: entry.modifiedBig !== null && entry.modifiedBig !== undefined ? entry.modifiedBig.toString() : null,
    createdRaw: entry.createdRaw,
    createdBig: entry.createdBig !== null && entry.createdBig !== undefined ? entry.createdBig.toString() : null,
    attributes: entry.attributes,
    attributeNumber: entry.attributeNumber,
    isDirectory: entry.isDirectory,
    searchIndex: entry.searchIndex,
    searchRaw: entry.searchRaw,
  };
}

function deserializeEntryFromCache(item) {
  return {
    ...item,
    sizeBig: item.sizeBig !== null && item.sizeBig !== undefined ? BigInt(item.sizeBig) : null,
    modifiedBig: item.modifiedBig !== null && item.modifiedBig !== undefined ? BigInt(item.modifiedBig) : null,
    createdBig: item.createdBig !== null && item.createdBig !== undefined ? BigInt(item.createdBig) : null,
  };
}

function loadCachedData() {
  try {
    const cached = localStorage.getItem(CACHE_STORAGE_KEY);
    if (!cached) return false;
    const data = JSON.parse(cached);
    if (!Array.isArray(data.entries) || !data.activeSource || !data.timestamp) {
      localStorage.removeItem(CACHE_STORAGE_KEY);
      return false;
    }
    if (Date.now() - data.timestamp >= CACHE_MAX_AGE_MS) {
      localStorage.removeItem(CACHE_STORAGE_KEY);
      return false;
    }

    state.entries = data.entries.map(deserializeEntryFromCache);
    state.activeSource = data.activeSource;
    setActiveSource(data.activeSource);
    applySearch("");
    return true;
  } catch (error) {
    console.warn("无法加载缓存数据:", error);
    try {
      localStorage.removeItem(CACHE_STORAGE_KEY);
    } catch {
      // 忽略清理异常
    }
    return false;
  }
}

function saveCachedData() {
  if (!state.activeSource) return;
  try {
    const payload = JSON.stringify({
      entries: state.entries.map(serializeEntryForCache),
      activeSource: state.activeSource,
      timestamp: Date.now(),
    });
    if (payload.length > CACHE_MAX_BYTES) {
      localStorage.removeItem(CACHE_STORAGE_KEY);
      return;
    }
    localStorage.setItem(CACHE_STORAGE_KEY, payload);
  } catch (error) {
    console.warn("无法缓存数据:", error);
  }
}

function closeCurrentFile() {
  if (!state.activeSource) return;

  const currentFileName = state.activeSource.label || state.activeSource.path;
  resetData();

  try {
    localStorage.removeItem(CACHE_STORAGE_KEY);
  } catch {
    // 忽略清理异常
  }

  if (currentFileName && state.localUploads[currentFileName]) {
    delete state.localUploads[currentFileName];
  }

  state.activeSource = null;
  setActiveSource(null);
  hideStatusBanner();
  hideDemoHintBanner();
  render();
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

function resolveEffectiveTheme(choice) {
  if (choice === "dark") return "dark";
  if (choice === "light") return "light";
  return getSystemPrefersDark() ? "dark" : "light";
}

function applyTheme() {
  const choice = THEME_SEQUENCE.includes(state.theme) ? state.theme : "system";
  state.theme = choice;
  const effective = resolveEffectiveTheme(choice);
  const root = document.documentElement;
  root.classList.remove("theme-light", "theme-dark");
  root.classList.add(effective === "dark" ? "theme-dark" : "theme-light");
  root.dataset.themeChoice = choice;
  try {
    localStorage.setItem("efu-theme", choice);
  } catch {
    // 忽略存储失败
  }
  updateThemeOptions();
}

function updateThemeOptions() {
  const meta = THEME_META[state.theme] || THEME_META.system;
  if (refs.themeOptions) {
    refs.themeOptions.forEach((button) => {
      const target = button.dataset.themeOption;
      const active = target === state.theme;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }
  if (refs.openSettings) {
    refs.openSettings.setAttribute("aria-label", `打开设置（当前主题：${meta.label}）`);
  }
}

function showUploadProgress(label) {
  if (!refs.uploadProgress) return;
  refs.uploadProgress.classList.remove("hidden");
  refs.uploadProgress.setAttribute("aria-label", `正在加载 ${label}`);
  updateUploadProgress(0);
}

function updateUploadProgress(value) {
  if (!refs.uploadProgressBar || !refs.uploadProgressText) return;
  const percentage = Math.max(0, Math.min(100, Math.round(value)));
  refs.uploadProgressBar.style.width = `${percentage}%`;
  refs.uploadProgressText.textContent = `${percentage}%`;
}

function hideUploadProgress() {
  if (!refs.uploadProgress) return;
  refs.uploadProgress.classList.add("hidden");
  if (refs.uploadProgressBar) {
    refs.uploadProgressBar.style.width = "0%";
  }
  if (refs.uploadProgressText) {
    refs.uploadProgressText.textContent = "0%";
  }
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
  hideUploadProgress();
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

function readLocalFile(file, { rememberSource = false } = {}) {
  if (!file) return;
  const label = file.name || "本地文件";
  if (!label.toLowerCase().endsWith(".efu")) {
    showStatusBanner("只允许加载 .efu 文件");
    return;
  }

  // 取消任何正在进行的服务器索引请求，避免迟到请求覆盖本地文件
  state.activeLoadId += 1;
  if (state.activeAbortController) {
    try {
      state.activeAbortController.abort();
    } catch {
      // ignore
    }
    state.activeAbortController = null;
  }

  showUploadProgress(label);

  const reader = new FileReader();
  reader.onloadstart = () => updateUploadProgress(0);
  reader.onprogress = (event) => {
    if (event.lengthComputable) {
      updateUploadProgress((event.loaded / event.total) * 100);
    }
  };
  reader.onerror = () => {
    hideUploadProgress();
    showStatusBanner(`读取本地文件「${label}」失败`);
  };
  reader.onload = () => {
    hideUploadProgress();
    try {
      ingestContent(String(reader.result || ""), {
        type: rememberSource ? "upload" : "local",
        label,
        path: label,
        snapshotModified: null,
      });
      if (rememberSource && refs.uploadName) {
        refs.uploadName.textContent = label;
      }
      if (rememberSource) {
        state.localUploads[label] = true;
        closePanels();
      }
    } catch (error) {
      const keepHint = state.activeSource ? "（已保留当前显示结果）" : "";
      showStatusBanner(`解析本地文件「${label}」失败：${error.message}${keepHint}`);
    }
  };
  reader.readAsText(file, "utf-8");
}

function applyColumnVisibility() {
  Object.entries(COLUMN_CLASSES).forEach(([key, className]) => {
    const visible = state.visibleColumns[key];
    document.querySelectorAll(`.${className}`).forEach((node) => {
      node.classList.toggle("hidden-column", !visible);
    });
  });

  const table = document.querySelector("table");
  if (!table) return;

  table.classList.remove(
    "table-columns-all",
    "table-columns-no-created",
    "table-columns-no-attributes",
    "table-columns-no-size",
    "table-columns-no-created-attributes",
    "table-columns-core",
    "table-columns-minimal"
  );

  const visibleColumns = Object.entries(state.visibleColumns)
    .filter(([, visible]) => visible)
    .map(([key]) => key);

  const hasFile = visibleColumns.includes("FileName");
  const hasPath = visibleColumns.includes("Path");
  const hasSize = visibleColumns.includes("Size");
  const hasModified = visibleColumns.includes("Date Modified");
  const hasCreated = visibleColumns.includes("Date Created");
  const hasAttributes = visibleColumns.includes("Attributes");
  const columnCount = visibleColumns.length;

  if (columnCount === 6) {
    table.classList.add("table-columns-all");
  } else if (columnCount === 5) {
    if (!hasCreated) table.classList.add("table-columns-no-created");
    else if (!hasAttributes) table.classList.add("table-columns-no-attributes");
    else if (!hasSize) table.classList.add("table-columns-no-size");
    else table.classList.add("table-columns-all");
  } else if (columnCount === 4 && !hasCreated && !hasAttributes) {
    table.classList.add("table-columns-no-created-attributes");
  } else if (columnCount === 3 && hasFile && hasPath && hasModified) {
    table.classList.add("table-columns-core");
  } else if (columnCount === 2 && hasFile && hasPath) {
    table.classList.add("table-columns-minimal");
  } else {
    table.classList.add("table-columns-all");
  }
}

const debouncedSearch = debounce((event) => {
  applySearch(event.target.value || "");
}, 180);

function bindEvents() {
  if (refs.searchInput) {
    refs.searchInput.addEventListener("input", debouncedSearch);
  }
  if (refs.clearSearch) {
    refs.clearSearch.addEventListener("click", () => {
      if (refs.searchInput) refs.searchInput.value = "";
      applySearch("");
    });
  }
  refs.headers.forEach((header) => header.addEventListener("click", handleSortClick));

  if (refs.serverIndexSelect) {
    refs.serverIndexSelect.addEventListener("change", (event) => {
      const targetId = event.target.value;
      if (targetId) {
        loadServerIndex(targetId);
      }
    });
  }
  if (refs.reloadServerIndex) {
    refs.reloadServerIndex.addEventListener("click", () => {
      const targetId =
        refs.serverIndexSelect?.value ||
        state.selectedServerIndexId ||
        state.defaultServerIndexId;
      if (targetId) {
        loadServerIndex(targetId, { isReload: true });
      }
    });
  }
  if (refs.statusBannerDismiss) {
    refs.statusBannerDismiss.addEventListener("click", hideStatusBanner);
  }

  if (refs.fileSelector) {
    refs.fileSelector.addEventListener("change", (event) => {
      if (refs.loadSelected) {
        refs.loadSelected.disabled = !event.target.value;
      }
    });
  }
  if (refs.loadSelected) {
    refs.loadSelected.addEventListener("click", async () => {
      const targetId = refs.fileSelector?.value;
      if (!targetId) return;
      await loadServerIndex(targetId);
    });
  }

  if (refs.uploadTrigger) {
    refs.uploadTrigger.addEventListener("click", () => {
      refs.fileUpload?.click();
    });
  }
  if (refs.fileUpload) {
    refs.fileUpload.addEventListener("change", handleFileUpload);
  }
  if (refs.openSource) {
    refs.openSource.addEventListener("click", () => {
      openPanel(refs.sourcePanel);
    });
  }
  if (refs.closeCurrent) {
    refs.closeCurrent.addEventListener("click", closeCurrentFile);
  }
  if (refs.closeSource) {
    refs.closeSource.addEventListener("click", closePanels);
  }
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      if (state.theme === "system") {
        applyTheme();
      }
    };
    if (typeof colorSchemeQuery.addEventListener === "function") {
      colorSchemeQuery.addEventListener("change", handleSystemThemeChange);
    } else if (typeof colorSchemeQuery.addListener === "function") {
      colorSchemeQuery.addListener(handleSystemThemeChange);
    }
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
      applySearch(refs.searchInput ? refs.searchInput.value : "");
    });
  }
  if (refs.toggleIncludeDirs) {
    refs.toggleIncludeDirs.addEventListener("change", (event) => {
      state.includeDirectories = event.target.checked;
      applySearch(refs.searchInput ? refs.searchInput.value : "");
    });
  }
  if (refs.toggleCaseSensitive) {
    refs.toggleCaseSensitive.addEventListener("change", (event) => {
      state.caseSensitive = event.target.checked;
      applySearch(refs.searchInput ? refs.searchInput.value : "");
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

  document.addEventListener("click", (event) => {
    const emptyState = event.target.closest(".empty-state");
    if (emptyState && emptyState.dataset.action === "open-local" && refs.results.contains(emptyState)) {
      refs.fileUpload?.click();
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
      state.page = Math.min(Math.floor(value), totalPages);
      render();
    });
  }
  refs.routeLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      const targetRoute = link.dataset.route;
      if (!targetRoute) return;
      event.preventDefault();
      navigateTo(targetRoute, { updateHash: true });
    });
  });

  if (typeof window !== "undefined") {
    window.addEventListener("hashchange", () => {
      navigateTo(resolveRouteFromLocation(), { updateHash: false });
    });
  }

  if (refs.demoHintApply) {
    refs.demoHintApply.addEventListener("click", () => {
      if (!state.demoSuggestedSearch) return;
      if (refs.searchInput) {
        refs.searchInput.value = state.demoSuggestedSearch;
        refs.searchInput.focus();
      }
      applySearch(state.demoSuggestedSearch);
    });
  }

  if (refs.demoHintDismiss) {
    refs.demoHintDismiss.addEventListener("click", hideDemoHintBanner);
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
  event.target.value = "";
  if (!file) return;

  if (!file.name.toLowerCase().endsWith(".efu")) {
    showStatusBanner("只允许打开 .efu 文件");
    return;
  }

  readLocalFile(file, { rememberSource: true });
}

if (typeof window !== "undefined") {
  window.__efuApp = {
    state,
    navigateTo,
    loadServerIndex,
    openDemoResult,
    ingestContent,
    applySearch,
    loadRuntimeConfig,
    getScansService: () => scansServiceInstance,
  };
  init();
}
