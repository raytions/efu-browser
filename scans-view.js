(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === "object") {
    root.EfuScansView = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEMO_STATUS_LABELS = {
    idle: "待扫描（模拟）",
    queued: "等待中（模拟）",
    scanning: "扫描中（模拟）",
    completed: "已完成（模拟）",
  };

  const REAL_STATUS_LABELS = {
    idle: "待机",
    running: "扫描中",
    succeeded: "已完成",
    failed: "失败",
  };

  const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  function formatIsoTimestamp(raw) {
    if (!raw) return "暂无记录";
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return String(raw);
    return dateTimeFormatter.format(date);
  }

  function slugifyOutputName(pathStr) {
    const clean = String(pathStr || "").replace(/\/+$/, "");
    const parts = clean.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "scan";
    const slug = last
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .replace(/-+/g, "-")
      .replace(/[-.]+$/, "")
      .slice(0, 48);
    return `${slug || "scan"}.efu`;
  }

  function suggestTaskName(pathStr) {
    const clean = String(pathStr || "").replace(/\/+$/, "");
    const parts = clean.split("/").filter(Boolean);
    return parts[parts.length - 1] || "新扫描任务";
  }

  function parseExcludesInput(text) {
    return String(text || "")
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function createScansView({ container, service, onOpenResult }) {
    if (!container || !service) {
      throw new Error("createScansView requires container and service");
    }

    container.textContent = "";
    const topMount = document.createElement("div");
    topMount.className = "scans-region";
    const wizardMount = document.createElement("div");
    wizardMount.className = "scans-region";
    const bodyMount = document.createElement("div");
    bodyMount.className = "scans-region";
    container.append(topMount, wizardMount, bodyMount);

    let pendingDeleteId = null;

    const wizard = {
      open: false,
      loadingRoots: false,
      loadingEntries: false,
      submitting: false,
      roots: [],
      selectedRootId: null,
      currentPath: "",
      relativePath: "",
      parentRelativePath: null,
      entries: [],
      browserError: null,
      formError: null,
      name: "",
      outputName: "",
      excludesText: ".snapshot, @eaDir",
      exportPrefix: "",
      nameDirty: false,
      outputDirty: false,
    };

    function resetWizard() {
      wizard.open = false;
      wizard.loadingRoots = false;
      wizard.loadingEntries = false;
      wizard.submitting = false;
      wizard.roots = [];
      wizard.selectedRootId = null;
      wizard.currentPath = "";
      wizard.relativePath = "";
      wizard.parentRelativePath = null;
      wizard.entries = [];
      wizard.browserError = null;
      wizard.formError = null;
      wizard.name = "";
      wizard.outputName = "";
      wizard.excludesText = ".snapshot, @eaDir";
      wizard.exportPrefix = "";
      wizard.nameDirty = false;
      wizard.outputDirty = false;
    }

    function applySelectedPath(pathStr) {
      wizard.currentPath = pathStr || "";
      if (wizard.currentPath) {
        if (!wizard.nameDirty) {
          wizard.name = suggestTaskName(wizard.currentPath);
        }
        if (!wizard.outputDirty) {
          wizard.outputName = slugifyOutputName(wizard.currentPath);
        }
      }
    }

    async function loadDirectoryEntries(rootId, relativePath = "") {
      if (typeof service.browseRootEntries !== "function") return;
      wizard.selectedRootId = rootId;
      wizard.loadingEntries = true;
      wizard.browserError = null;
      renderWizard();

      const res = await service.browseRootEntries(rootId, relativePath);
      if (!wizard.open || wizard.selectedRootId !== rootId) return;

      wizard.loadingEntries = false;
      if (!res || !res.ok || !res.data) {
        wizard.entries = [];
        wizard.browserError = (res && res.error) || "无法读取该目录下的子目录";
        renderWizard();
        return;
      }

      wizard.relativePath = res.data.relativePath || "";
      wizard.parentRelativePath =
        res.data.parentRelativePath === undefined ? null : res.data.parentRelativePath;
      wizard.entries = Array.isArray(res.data.entries) ? res.data.entries : [];
      applySelectedPath(res.data.currentPath || "");
      wizard.browserError = null;
      renderWizard();
    }

    async function openWizard() {
      if (wizard.open) {
        resetWizard();
        renderWizard();
        renderCurrent();
        return;
      }
      resetWizard();
      wizard.open = true;
      wizard.loadingRoots = true;
      renderWizard();
      renderCurrent();

      if (typeof service.listRoots !== "function") {
        wizard.loadingRoots = false;
        wizard.browserError = "当前服务不支持目录选择接口";
        renderWizard();
        return;
      }

      const res = await service.listRoots();
      if (!wizard.open) return;

      wizard.loadingRoots = false;
      if (!res || !res.ok) {
        wizard.roots = [];
        wizard.browserError = (res && res.error) || "无法加载允许的扫描根目录";
        renderWizard();
        return;
      }

      wizard.roots = Array.isArray(res.roots) ? res.roots : [];
      if (wizard.roots.length === 0) {
        wizard.browserError =
          "服务器尚未配置任何允许的扫描根目录（SCANS_ALLOWED_ROOTS / allowedRoots）。";
        renderWizard();
        return;
      }

      await loadDirectoryEntries(wizard.roots[0].id, "");
    }

    async function submitWizardForm() {
      if (wizard.submitting || typeof service.createTask !== "function") return;

      const trimmedName = wizard.name.trim();
      let trimmedOutput = wizard.outputName.trim();
      const trimmedRoot = wizard.currentPath.trim();
      const excludes = parseExcludesInput(wizard.excludesText);
      const exportPrefix = wizard.exportPrefix.trim();

      if (!trimmedRoot) {
        wizard.formError = "请先在上方目录列表中选择一个允许范围内的扫描目录。";
        renderWizard();
        return;
      }
      if (!trimmedName) {
        wizard.formError = "请填写任务名称。";
        renderWizard();
        return;
      }
      if (!trimmedOutput) {
        trimmedOutput = slugifyOutputName(trimmedRoot);
      } else if (!/\.efu$/i.test(trimmedOutput)) {
        trimmedOutput = `${trimmedOutput}.efu`;
      }

      wizard.submitting = true;
      wizard.formError = null;
      renderWizard();

      const payload = {
        name: trimmedName,
        root: trimmedRoot,
        rootId: wizard.selectedRootId || undefined,
        excludes,
        outputName: trimmedOutput,
      };
      if (exportPrefix) {
        payload.exportPrefix = exportPrefix;
      }

      const result = await service.createTask(payload);
      if (!wizard.open) return;

      wizard.submitting = false;
      if (!result || !result.ok) {
        wizard.formError = (result && result.error) || "保存扫描任务失败，请检查配置。";
        renderWizard();
        return;
      }

      resetWizard();
      renderWizard();
      renderCurrent();
    }

    function renderWizard() {
      wizardMount.textContent = "";
      if (!wizard.open) return;

      const panel = document.createElement("section");
      panel.className = "scan-wizard-panel";
      panel.dataset.scanWizard = "open";
      panel.setAttribute("aria-label", "添加扫描目标");

      const panelHeader = document.createElement("div");
      panelHeader.className = "scan-wizard-header";

      const titleWrap = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = service.isDemo ? "添加模拟扫描目标（仅演示）" : "添加扫描目标";
      const hint = document.createElement("p");
      hint.className = "scan-wizard-hint";
      hint.textContent = service.isDemo
        ? "演示模式：以下为纯前端虚构目录树，不会访问你的设备、服务器或 NAS，也不会请求任何后端接口。"
        : "仅可在管理员预先授权的扫描根目录下逐级选择目录，目录枚举只显示下一层子目录，不读取文件内容。";
      titleWrap.append(title, hint);

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "btn-secondary";
      closeBtn.dataset.action = "close-add-target";
      closeBtn.textContent = "关闭";
      closeBtn.addEventListener("click", () => {
        resetWizard();
        renderWizard();
        renderCurrent();
      });

      panelHeader.append(titleWrap, closeBtn);
      panel.appendChild(panelHeader);

      // Step 1: Allowed roots + subdirectory browser
      const browserSection = document.createElement("div");
      browserSection.className = "scan-picker-box";

      const rootsRow = document.createElement("div");
      rootsRow.className = "scan-roots-bar";

      const rootsLabel = document.createElement("span");
      rootsLabel.className = "scan-picker-label";
      rootsLabel.textContent = "已授权根目录";
      rootsRow.appendChild(rootsLabel);

      if (wizard.loadingRoots) {
        const loadingSpan = document.createElement("span");
        loadingSpan.className = "scan-picker-muted";
        loadingSpan.textContent = "正在加载允许的根目录...";
        rootsRow.appendChild(loadingSpan);
      } else {
        const rootBtns = document.createElement("div");
        rootBtns.className = "scan-roots-pills";
        wizard.roots.forEach((rootItem) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className =
            rootItem.id === wizard.selectedRootId
              ? "scan-root-pill active"
              : "scan-root-pill";
          btn.dataset.rootId = rootItem.id;
          btn.textContent = `${rootItem.name} (${rootItem.path})`;
          btn.addEventListener("click", () => {
            loadDirectoryEntries(rootItem.id, "");
          });
          rootBtns.appendChild(btn);
        });
        rootsRow.appendChild(rootBtns);
      }
      browserSection.appendChild(rootsRow);

      if (wizard.currentPath) {
        const pathBar = document.createElement("div");
        pathBar.className = "scan-picker-pathbar";

        const selectedWrap = document.createElement("div");
        selectedWrap.className = "scan-picker-current";
        const currentLabel = document.createElement("span");
        currentLabel.className = "scan-picker-label";
        currentLabel.textContent = "当前已选扫描目录：";
        const currentCode = document.createElement("code");
        currentCode.className = "scan-path";
        currentCode.dataset.selectedRootPath = wizard.currentPath;
        currentCode.textContent = wizard.currentPath;
        selectedWrap.append(currentLabel, currentCode);

        const navBtns = document.createElement("div");
        navBtns.className = "scan-picker-nav";
        const upBtn = document.createElement("button");
        upBtn.type = "button";
        upBtn.className = "btn-secondary";
        upBtn.dataset.action = "browse-up";
        upBtn.textContent = "返回上一级";
        upBtn.disabled = wizard.loadingEntries || wizard.parentRelativePath === null;
        upBtn.addEventListener("click", () => {
          if (wizard.selectedRootId && wizard.parentRelativePath !== null) {
            loadDirectoryEntries(wizard.selectedRootId, wizard.parentRelativePath);
          }
        });
        navBtns.appendChild(upBtn);

        pathBar.append(selectedWrap, navBtns);
        browserSection.appendChild(pathBar);
      }

      if (wizard.browserError) {
        const err = document.createElement("div");
        err.className = "scan-error-inline";
        err.setAttribute("role", "alert");
        err.textContent = wizard.browserError;
        browserSection.appendChild(err);
      } else if (wizard.loadingEntries) {
        const loadingDir = document.createElement("p");
        loadingDir.className = "scan-picker-muted";
        loadingDir.textContent = "正在读取下一层子目录...";
        browserSection.appendChild(loadingDir);
      } else if (wizard.selectedRootId) {
        const dirList = document.createElement("div");
        dirList.className = "scan-dir-list";
        dirList.setAttribute("role", "list");

        if (wizard.entries.length === 0) {
          const empty = document.createElement("p");
          empty.className = "scan-picker-muted";
          empty.textContent = "当前目录下没有子目录，可直接将此目录保存为扫描任务。";
          dirList.appendChild(empty);
        } else {
          wizard.entries.forEach((entry) => {
            const itemBtn = document.createElement("button");
            itemBtn.type = "button";
            itemBtn.className = "scan-dir-item";
            itemBtn.dataset.entryName = entry.name;
            itemBtn.dataset.entryRel = entry.relativePath;
            itemBtn.dataset.entryPath = entry.path;

            const nameSpan = document.createElement("span");
            nameSpan.className = "scan-dir-name";
            nameSpan.textContent = `📁 ${entry.name}`;

            const arrowSpan = document.createElement("span");
            arrowSpan.className = "scan-dir-arrow";
            arrowSpan.textContent = "进入 →";

            itemBtn.append(nameSpan, arrowSpan);
            itemBtn.addEventListener("click", () => {
              loadDirectoryEntries(wizard.selectedRootId, entry.relativePath);
            });
            dirList.appendChild(itemBtn);
          });
        }
        browserSection.appendChild(dirList);
      }

      panel.appendChild(browserSection);

      // Step 2: Task metadata form
      const form = document.createElement("form");
      form.className = "scan-wizard-form";
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        submitWizardForm();
      });

      const grid = document.createElement("div");
      grid.className = "scan-form-grid";

      // Task name
      const nameField = document.createElement("label");
      nameField.className = "scan-form-field";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = "任务名称 *";
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.name = "taskName";
      nameInput.required = true;
      nameInput.placeholder = "例如：科研切片归档";
      nameInput.value = wizard.name;
      nameInput.addEventListener("input", (e) => {
        wizard.name = e.target.value;
        wizard.nameDirty = true;
      });
      nameField.append(nameSpan, nameInput);

      // Output EFU name
      const outField = document.createElement("label");
      outField.className = "scan-form-field";
      const outSpan = document.createElement("span");
      outSpan.textContent = "EFU 输出文件名 *";
      const outInput = document.createElement("input");
      outInput.type = "text";
      outInput.name = "outputName";
      outInput.required = true;
      outInput.placeholder = "例如：slides.efu";
      outInput.value = wizard.outputName;
      outInput.addEventListener("input", (e) => {
        wizard.outputName = e.target.value;
        wizard.outputDirty = true;
      });
      const outHelp = document.createElement("small");
      outHelp.textContent = "仅允许安全文件名（字母/数字/._-）且限制在受控索引目录 /indexes/ 内。";
      outField.append(outSpan, outInput, outHelp);

      // Excludes
      const exField = document.createElement("label");
      exField.className = "scan-form-field";
      const exSpan = document.createElement("span");
      exSpan.textContent = "排除目录/名称（逗号或换行分隔）";
      const exInput = document.createElement("input");
      exInput.type = "text";
      exInput.name = "excludes";
      exInput.placeholder = ".snapshot, @eaDir, #recycle";
      exInput.value = wizard.excludesText;
      exInput.addEventListener("input", (e) => {
        wizard.excludesText = e.target.value;
      });
      exField.append(exSpan, exInput);

      // Export prefix
      const prefixField = document.createElement("label");
      prefixField.className = "scan-form-field";
      const prefixSpan = document.createElement("span");
      prefixSpan.textContent = "导出路径前缀（可选）";
      const prefixInput = document.createElement("input");
      prefixInput.type = "text";
      prefixInput.name = "exportPrefix";
      prefixInput.placeholder = "例如：\\\\nas\\research 或 /shared/nas";
      prefixInput.value = wizard.exportPrefix;
      prefixInput.addEventListener("input", (e) => {
        wizard.exportPrefix = e.target.value;
      });
      const prefixHelp = document.createElement("small");
      prefixHelp.textContent = "仅改写 EFU 内的显示路径，不改变服务器实际扫描位置。";
      prefixField.append(prefixSpan, prefixInput, prefixHelp);

      grid.append(nameField, outField, exField, prefixField);
      form.appendChild(grid);

      if (wizard.formError) {
        const err = document.createElement("div");
        err.className = "scan-error-inline";
        err.setAttribute("role", "alert");
        err.textContent = wizard.formError;
        form.appendChild(err);
      }

      const formActions = document.createElement("div");
      formActions.className = "scan-actions";

      const submitBtn = document.createElement("button");
      submitBtn.type = "submit";
      submitBtn.className = "btn-primary";
      submitBtn.dataset.action = "submit-create-task";
      submitBtn.disabled = wizard.submitting || !wizard.currentPath;
      submitBtn.textContent = wizard.submitting
        ? "保存中..."
        : service.isDemo
          ? "保存模拟任务"
          : "保存为扫描任务";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn-secondary";
      cancelBtn.textContent = "取消";
      cancelBtn.addEventListener("click", () => {
        resetWizard();
        renderWizard();
        renderCurrent();
      });

      formActions.append(submitBtn, cancelBtn);
      form.appendChild(formActions);
      panel.appendChild(form);

      wizardMount.appendChild(panel);
    }

    function appendExcludesAndExtras(identityEl, job) {
      const rootPath = job.root || job.rootPath;
      if (rootPath) {
        const pathEl = document.createElement("code");
        pathEl.className = "scan-path";
        pathEl.textContent = rootPath;
        identityEl.appendChild(pathEl);
      }

      const tagsRow = document.createElement("div");
      tagsRow.className = "scan-config-tags";

      if (job.outputName) {
        const outChip = document.createElement("span");
        outChip.className = "scan-config-chip";
        outChip.textContent = `EFU: ${job.outputName}`;
        tagsRow.appendChild(outChip);
      }

      if (job.exportPrefix) {
        const prefixChip = document.createElement("span");
        prefixChip.className = "scan-config-chip";
        prefixChip.textContent = `前缀: ${job.exportPrefix}`;
        tagsRow.appendChild(prefixChip);
      }

      if (Array.isArray(job.excludes) && job.excludes.length > 0) {
        const exChip = document.createElement("span");
        exChip.className = "scan-config-chip";
        exChip.textContent = `排除: ${job.excludes.join(", ")}`;
        tagsRow.appendChild(exChip);
      }

      if (tagsRow.childNodes.length > 0) {
        identityEl.appendChild(tagsRow);
      }
    }

    function appendDeleteControl(actionsEl, job, isBusy) {
      if (typeof service.deleteTask !== "function") return;
      if (pendingDeleteId === job.id) {
        const confirmBtn = document.createElement("button");
        confirmBtn.type = "button";
        confirmBtn.className = "btn-danger";
        confirmBtn.dataset.action = "confirm-delete-task";
        confirmBtn.disabled = isBusy;
        confirmBtn.textContent = "确认删除任务";
        confirmBtn.title = "仅删除任务定义，不删除历史 EFU 快照";
        confirmBtn.addEventListener("click", async () => {
          pendingDeleteId = null;
          await service.deleteTask(job.id);
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "btn-secondary";
        cancelBtn.dataset.action = "cancel-delete-task";
        cancelBtn.textContent = "取消";
        cancelBtn.addEventListener("click", () => {
          pendingDeleteId = null;
          renderCurrent();
        });

        actionsEl.append(confirmBtn, cancelBtn);
      } else {
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "btn-secondary scan-delete-btn";
        deleteBtn.dataset.action = "delete-task";
        deleteBtn.disabled = isBusy;
        deleteBtn.textContent = "删除任务";
        deleteBtn.title = "仅删除任务定义，保留历史 EFU 快照";
        deleteBtn.addEventListener("click", () => {
          pendingDeleteId = job.id;
          renderCurrent();
        });
        actionsEl.appendChild(deleteBtn);
      }
    }

    function renderDemo(jobs) {
      topMount.textContent = "";
      bodyMount.textContent = "";

      const banner = document.createElement("div");
      banner.className = "scans-demo-banner";
      banner.setAttribute("role", "note");

      const badge = document.createElement("span");
      badge.className = "scans-demo-badge";
      badge.textContent = service.demoBannerTitle || "演示模式";

      const desc = document.createElement("p");
      desc.className = "scans-demo-desc";
      desc.textContent =
        service.demoBannerDescription || "这是模拟扫描，不会访问你的设备、服务器或 NAS。";

      banner.append(badge, desc);
      topMount.appendChild(banner);

      const header = document.createElement("div");
      header.className = "scans-header";

      const titleWrap = document.createElement("div");
      const h2 = document.createElement("h2");
      h2.textContent = "扫描任务";
      const subtitle = document.createElement("p");
      subtitle.className = "scans-subtitle";
      subtitle.textContent =
        "在浏览器中体验模拟目录选择与快照更新流程；不会读取你的本机文件，也不会在扫描完成后自动覆盖 Browser 当前已打开的索引。";
      titleWrap.append(h2, subtitle);

      const headerActions = document.createElement("div");
      headerActions.className = "scans-header-actions";
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btn-primary";
      addBtn.dataset.action = "open-add-target";
      addBtn.textContent = wizard.open ? "收起添加面板" : "添加扫描目标";
      addBtn.addEventListener("click", () => {
        openWizard();
      });
      headerActions.appendChild(addBtn);

      header.append(titleWrap, headerActions);
      topMount.appendChild(header);

      const list = document.createElement("div");
      list.className = "scans-list";

      jobs.forEach((job) => {
        list.appendChild(renderDemoJobCard(job));
      });

      bodyMount.appendChild(list);
    }

    function renderDemoJobCard(job) {
      const card = document.createElement("article");
      card.className = "scan-card";
      card.dataset.jobId = job.id;
      card.dataset.status = job.status;

      const isBusy = job.status === "queued" || job.status === "scanning";

      const topRow = document.createElement("div");
      topRow.className = "scan-card-top";

      const identity = document.createElement("div");
      identity.className = "scan-identity";

      const nameRow = document.createElement("div");
      nameRow.className = "scan-name-row";

      const title = document.createElement("h3");
      title.textContent = job.name;

      const demoTag = document.createElement("span");
      demoTag.className = "scan-tag";
      demoTag.textContent = "虚构任务";

      nameRow.append(title, demoTag);
      identity.append(nameRow);
      appendExcludesAndExtras(identity, job);

      const statusBadge = document.createElement("span");
      statusBadge.className = `scan-status-pill scan-status-${job.status}`;
      statusBadge.dataset.scanStatus = job.status;
      statusBadge.textContent = DEMO_STATUS_LABELS[job.status] || job.status;

      topRow.append(identity, statusBadge);

      const metaGrid = document.createElement("dl");
      metaGrid.className = "scan-meta-grid";
      metaGrid.append(
        createMetaItem("最近成功时间", job.lastSuccessAt),
        createMetaItem(
          "快照条目数",
          job.hasCompletedRun
            ? `${job.entryCount} 条（扫描前 ${job.beforeEntryCount} 条，+${job.addedFiles.length}）`
            : `${job.entryCount} 条（扫描前基线）`
        ),
        createMetaItem("执行方式", job.scheduleLabel)
      );

      const progressBlock = document.createElement("div");
      progressBlock.className = "scan-progress-block";

      const progressHeader = document.createElement("div");
      progressHeader.className = "scan-progress-header";

      const progressMsg = document.createElement("span");
      progressMsg.className = "scan-progress-message";
      progressMsg.textContent = job.statusMessage;

      const progressPct = document.createElement("span");
      progressPct.className = "scan-progress-pct tabular-nums";
      progressPct.textContent =
        job.status === "idle" ? "模拟进度 0%" : `模拟进度 ${job.progress}%`;

      progressHeader.append(progressMsg, progressPct);

      const track = document.createElement("div");
      track.className = "scan-progress-track";
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(job.progress));
      track.setAttribute("aria-label", `${job.name} 模拟扫描进度`);

      const fill = document.createElement("div");
      fill.className = `scan-progress-fill scan-progress-${job.status}`;
      fill.style.width = `${job.progress}%`;
      track.appendChild(fill);

      progressBlock.append(progressHeader, track);

      let completionBox = null;
      if (job.hasCompletedRun && job.status === "completed") {
        completionBox = document.createElement("div");
        completionBox.className = "scan-completion-note";
        completionBox.setAttribute("role", "status");

        const noteText = document.createElement("p");
        noteText.textContent = `模拟快照已更新（${job.beforeEntryCount} → ${job.afterEntryCount} 条），新增虚构文件 `;

        const codeHint = document.createElement("code");
        codeHint.textContent = job.suggestedSearch;

        const tailText = document.createTextNode(
          "。点击「打开结果」将在 Browser 中加载新版演示快照，建议搜索该文件名验证差异。"
        );

        noteText.append(codeHint, tailText);
        completionBox.appendChild(noteText);
      }

      const actions = document.createElement("div");
      actions.className = "scan-actions";

      const scanBtn = document.createElement("button");
      scanBtn.type = "button";
      scanBtn.className = "btn-primary scan-run-btn";
      scanBtn.dataset.action = "start-scan";
      scanBtn.disabled = isBusy;
      scanBtn.textContent =
        job.status === "queued"
          ? "模拟等待中..."
          : job.status === "scanning"
            ? "模拟扫描中..."
            : "立即扫描";
      scanBtn.addEventListener("click", () => {
        service.startScan(job.id);
      });

      actions.appendChild(scanBtn);

      if (job.hasCompletedRun && job.status === "completed") {
        const openAfterBtn = document.createElement("button");
        openAfterBtn.type = "button";
        openAfterBtn.className = "btn-accent scan-open-result-btn";
        openAfterBtn.dataset.action = "open-result";
        openAfterBtn.textContent = "打开结果";
        openAfterBtn.addEventListener("click", () => {
          if (typeof onOpenResult === "function") {
            onOpenResult({
              type: "demo",
              jobId: job.id,
              phase: "after",
              url: job.afterUrl,
              label: `${job.name}（模拟扫描后）`,
              suggestedSearch: job.suggestedSearch,
            });
          }
        });
        actions.appendChild(openAfterBtn);
      }

      const openBeforeBtn = document.createElement("button");
      openBeforeBtn.type = "button";
      openBeforeBtn.className = "btn-secondary scan-open-before-btn";
      openBeforeBtn.dataset.action = "open-before";
      openBeforeBtn.disabled = isBusy;
      openBeforeBtn.textContent = "查看扫描前快照";
      openBeforeBtn.addEventListener("click", () => {
        if (typeof onOpenResult === "function") {
          onOpenResult({
            type: "demo",
            jobId: job.id,
            phase: "before",
            url: job.beforeUrl,
            label: `${job.name}（模拟扫描前）`,
            suggestedSearch: null,
          });
        }
      });
      actions.appendChild(openBeforeBtn);

      if (job.id !== "example-nas") {
        appendDeleteControl(actions, job, isBusy);
      }

      card.append(topRow, metaGrid, progressBlock);
      if (completionBox) {
        card.appendChild(completionBox);
      }
      card.appendChild(actions);
      return card;
    }

    function renderReal(realState) {
      topMount.textContent = "";
      bodyMount.textContent = "";

      const banner = document.createElement("div");
      banner.className = "scans-real-banner";
      banner.setAttribute("role", "note");

      const badge = document.createElement("span");
      badge.className = "scans-real-badge";
      badge.textContent = "真实模式";

      const desc = document.createElement("p");
      desc.className = "scans-demo-desc";
      const modeFlags = [];
      modeFlags.push(realState.allowTrigger ? "允许网页触发" : "只读触发（SCANS_ALLOW_TRIGGER=false）");
      modeFlags.push(realState.allowManage ? "允许网页配置任务" : "只读任务配置（SCANS_ALLOW_MANAGE=false）");
      desc.textContent = `已连接到受控扫描服务（${modeFlags.join(" · ")}）。扫描在服务器端执行，完成后不会自动覆盖 Browser 当前打开的索引。`;

      banner.append(badge, desc);
      topMount.appendChild(banner);

      const header = document.createElement("div");
      header.className = "scans-header";

      const titleWrap = document.createElement("div");
      const h2 = document.createElement("h2");
      h2.textContent = "受控扫描任务";
      const subtitle = document.createElement("p");
      subtitle.className = "scans-subtitle";
      subtitle.textContent =
        "仅可在管理员授权的 allowedRoots 下选择目录；仅在扫描、校验与原子发布全部成功后更新快照，失败时保留上一份可用 EFU。";
      titleWrap.append(h2, subtitle);

      const headerActions = document.createElement("div");
      headerActions.className = "scans-header-actions";

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btn-primary";
      addBtn.dataset.action = "open-add-target";
      addBtn.disabled = !realState.allowManage || Boolean(realState.backendError);
      addBtn.textContent = wizard.open ? "收起添加面板" : "添加扫描目标";
      if (!realState.allowManage) {
        addBtn.title = "当前部署已设置 SCANS_ALLOW_MANAGE=false，仅管理员可在服务端配置任务";
      }
      addBtn.addEventListener("click", () => {
        openWizard();
      });

      const refreshBtn = document.createElement("button");
      refreshBtn.type = "button";
      refreshBtn.className = "btn-secondary";
      refreshBtn.dataset.action = "refresh-scans";
      refreshBtn.disabled = realState.loading;
      refreshBtn.textContent = realState.loading ? "刷新中..." : "刷新状态";
      refreshBtn.addEventListener("click", () => {
        if (typeof service.refresh === "function") {
          service.refresh();
        }
      });

      headerActions.append(addBtn, refreshBtn);
      header.append(titleWrap, headerActions);
      topMount.appendChild(header);

      if (realState.actionError) {
        const alertEl = document.createElement("div");
        alertEl.className = "status-banner";
        alertEl.setAttribute("role", "alert");
        const span = document.createElement("span");
        span.textContent = realState.actionError;
        alertEl.appendChild(span);
        topMount.appendChild(alertEl);
      }

      if (realState.backendError) {
        if (wizard.open) {
          resetWizard();
          renderWizard();
        }
        const errCard = document.createElement("div");
        errCard.className = "scan-error-card";
        errCard.setAttribute("role", "alert");

        const errTitle = document.createElement("h3");
        errTitle.textContent = "无法连接到服务器端扫描服务";

        const errText = document.createElement("p");
        errText.textContent = realState.backendError;

        const errHint = document.createElement("p");
        errHint.className = "scan-error-hint";
        errHint.textContent =
          "当前处于真实模式（SCANS_MODE=real），不会回退到演示模式，也不会展示模拟数据。";

        const retryBtn = document.createElement("button");
        retryBtn.type = "button";
        retryBtn.className = "btn-primary";
        retryBtn.dataset.action = "retry-scans";
        retryBtn.textContent = "重试连接";
        retryBtn.addEventListener("click", () => {
          service.refresh();
        });

        errCard.append(errTitle, errText, errHint, retryBtn);
        bodyMount.appendChild(errCard);
        return;
      }

      if (realState.loading && realState.jobs.length === 0) {
        const loadingCard = document.createElement("div");
        loadingCard.className = "scan-card";
        const loadingText = document.createElement("p");
        loadingText.className = "scans-subtitle";
        loadingText.textContent = "正在加载服务器扫描任务列表...";
        loadingCard.appendChild(loadingText);
        bodyMount.appendChild(loadingCard);
        return;
      }

      if (realState.jobs.length === 0) {
        const emptyCard = document.createElement("div");
        emptyCard.className = "scan-card";
        const emptyText = document.createElement("p");
        emptyText.className = "scans-subtitle";
        emptyText.textContent = realState.allowManage
          ? "当前尚未配置扫描任务，请点击右上角「添加扫描目标」在授权目录下选择目录并创建任务。"
          : "当前服务器扫描配置（scans.json）中未定义任何任务。";
        emptyCard.appendChild(emptyText);
        bodyMount.appendChild(emptyCard);
        return;
      }

      const list = document.createElement("div");
      list.className = "scans-list";
      realState.jobs.forEach((job) => {
        list.appendChild(renderRealJobCard(job, realState.allowTrigger, realState.allowManage));
      });
      bodyMount.appendChild(list);
    }

    function renderRealJobCard(job, allowTrigger, allowManage) {
      const card = document.createElement("article");
      card.className = "scan-card";
      card.dataset.jobId = job.id;
      card.dataset.status = job.status;

      const isRunning = job.status === "running" || Boolean(job.triggerPending);

      const topRow = document.createElement("div");
      topRow.className = "scan-card-top";

      const identity = document.createElement("div");
      identity.className = "scan-identity";

      const nameRow = document.createElement("div");
      nameRow.className = "scan-name-row";

      const title = document.createElement("h3");
      title.textContent = job.name;

      const idTag = document.createElement("code");
      idTag.className = "scan-tag";
      idTag.textContent = job.id;

      nameRow.append(title, idTag);

      if (!job.enabled) {
        const disabledTag = document.createElement("span");
        disabledTag.className = "scan-tag";
        disabledTag.textContent = "已禁用";
        nameRow.appendChild(disabledTag);
      }

      identity.append(nameRow);
      appendExcludesAndExtras(identity, job);

      const statusClass =
        job.status === "running"
          ? "scanning"
          : job.status === "succeeded"
            ? "completed"
            : job.status === "failed"
              ? "failed"
              : "idle";

      const statusBadge = document.createElement("span");
      statusBadge.className = `scan-status-pill scan-status-${statusClass}`;
      statusBadge.dataset.scanStatus = job.status;
      statusBadge.textContent = REAL_STATUS_LABELS[job.status] || job.status;

      topRow.append(identity, statusBadge);

      const metaGrid = document.createElement("dl");
      metaGrid.className = "scan-meta-grid";
      metaGrid.append(
        createMetaItem("上次成功时间", formatIsoTimestamp(job.lastSuccessAt)),
        createMetaItem(
          "最近快照条目数",
          typeof job.entryCount === "number" ? `${job.entryCount.toLocaleString()} 条` : "—"
        ),
        createMetaItem("计划调度", job.schedule || "手动 / 外部定时")
      );

      card.append(topRow, metaGrid);

      if (job.status === "running") {
        const runningNote = document.createElement("div");
        runningNote.className = "scan-completion-note";
        runningNote.setAttribute("role", "status");
        const p = document.createElement("p");
        p.textContent =
          "服务器正在后台执行 gdu 扫描与快照校验，请稍候；完成后可点击「打开结果」在 Browser 中加载新快照。";
        runningNote.appendChild(p);
        card.appendChild(runningNote);
      }

      if (job.errorSummary) {
        const errNote = document.createElement("div");
        errNote.className = "scan-error-inline";
        errNote.setAttribute("role", "alert");
        errNote.textContent = `最近错误：${job.errorSummary}`;
        card.appendChild(errNote);
      }

      const actions = document.createElement("div");
      actions.className = "scan-actions";

      const scanBtn = document.createElement("button");
      scanBtn.type = "button";
      scanBtn.className = "btn-primary scan-run-btn";
      scanBtn.dataset.action = "start-scan";
      scanBtn.disabled = isRunning || !job.enabled || !allowTrigger;
      scanBtn.textContent = isRunning ? "扫描中..." : "立即扫描";
      if (!allowTrigger) {
        scanBtn.title = "当前部署已设置 SCANS_ALLOW_TRIGGER=false";
      } else if (!job.enabled) {
        scanBtn.title = "该任务在配置中已禁用";
      }
      scanBtn.addEventListener("click", () => {
        service.startScan(job.id);
      });
      actions.appendChild(scanBtn);

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = job.hasSnapshot
        ? "btn-accent scan-open-result-btn"
        : "btn-secondary scan-open-result-btn";
      openBtn.dataset.action = "open-result";
      openBtn.disabled = !job.hasSnapshot;
      openBtn.textContent = "打开结果";
      if (!job.hasSnapshot) {
        openBtn.title = "尚未生成可用的 EFU 快照";
      }
      openBtn.addEventListener("click", () => {
        if (typeof onOpenResult === "function") {
          onOpenResult({
            type: "real",
            jobId: job.id,
            url: job.indexUrl,
            label: job.name,
            suggestedSearch: null,
          });
        }
      });
      actions.appendChild(openBtn);

      if (allowManage) {
        appendDeleteControl(actions, job, isRunning);
      }

      card.appendChild(actions);
      return card;
    }

    function createMetaItem(label, value) {
      const wrapper = document.createElement("div");
      wrapper.className = "scan-meta-item";

      const dt = document.createElement("dt");
      dt.textContent = label;

      const dd = document.createElement("dd");
      dd.className = "tabular-nums";
      dd.textContent = value;

      wrapper.append(dt, dd);
      return wrapper;
    }

    function renderCurrent() {
      if (service.isDemo) {
        renderDemo(service.listJobs());
      } else {
        renderReal(service.getState());
      }
    }

    const unsubscribe = service.subscribe((payload) => {
      if (service.isDemo) {
        renderDemo(payload);
      } else {
        renderReal(payload);
      }
    });

    renderCurrent();

    return {
      refresh() {
        if (!service.isDemo && typeof service.refresh === "function") {
          service.refresh();
        } else {
          renderCurrent();
        }
      },
      destroy() {
        unsubscribe();
      },
    };
  }

  return {
    DEMO_STATUS_LABELS,
    REAL_STATUS_LABELS,
    slugifyOutputName,
    parseExcludesInput,
    createScansView,
  };
});
