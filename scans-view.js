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

  function createScansView({ container, service, onOpenResult }) {
    if (!container || !service) {
      throw new Error("createScansView requires container and service");
    }

    function renderDemo(jobs) {
      container.textContent = "";

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
      container.appendChild(banner);

      const header = document.createElement("div");
      header.className = "scans-header";

      const titleWrap = document.createElement("div");
      const h2 = document.createElement("h2");
      h2.textContent = "扫描任务";
      const subtitle = document.createElement("p");
      subtitle.className = "scans-subtitle";
      subtitle.textContent =
        "在浏览器中体验模拟快照更新流程；不会读取你的本机文件，也不会在扫描完成后自动覆盖 Browser 当前已打开的索引。";
      titleWrap.append(h2, subtitle);
      header.appendChild(titleWrap);
      container.appendChild(header);

      const list = document.createElement("div");
      list.className = "scans-list";

      jobs.forEach((job) => {
        list.appendChild(renderDemoJobCard(job));
      });

      container.appendChild(list);
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

      const pathEl = document.createElement("code");
      pathEl.className = "scan-path";
      pathEl.textContent = job.rootPath;

      identity.append(nameRow, pathEl);

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

      card.append(topRow, metaGrid, progressBlock);
      if (completionBox) {
        card.appendChild(completionBox);
      }
      card.appendChild(actions);
      return card;
    }

    function renderReal(realState) {
      container.textContent = "";

      const banner = document.createElement("div");
      banner.className = "scans-real-banner";
      banner.setAttribute("role", "note");

      const badge = document.createElement("span");
      badge.className = "scans-real-badge";
      badge.textContent = "真实模式";

      const desc = document.createElement("p");
      desc.className = "scans-demo-desc";
      desc.textContent = realState.allowTrigger
        ? "已连接到受控扫描服务（已开启网页触发）。扫描在服务器端执行，完成后不会自动覆盖 Browser 当前打开的索引。"
        : "已连接到受控扫描服务（当前为只读状态查看，SCANS_ALLOW_TRIGGER=false，定时扫描由 cron / systemd timer 负责）。";

      banner.append(badge, desc);
      container.appendChild(banner);

      const header = document.createElement("div");
      header.className = "scans-header";

      const titleWrap = document.createElement("div");
      const h2 = document.createElement("h2");
      h2.textContent = "受控扫描任务";
      const subtitle = document.createElement("p");
      subtitle.className = "scans-subtitle";
      subtitle.textContent =
        "任务清单由服务器受控配置文件定义；仅在扫描、校验与原子发布全部成功后更新快照，失败时保留上一份可用 EFU。";
      titleWrap.append(h2, subtitle);

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

      header.append(titleWrap, refreshBtn);
      container.appendChild(header);

      if (realState.actionError) {
        const alertEl = document.createElement("div");
        alertEl.className = "status-banner";
        alertEl.setAttribute("role", "alert");
        const span = document.createElement("span");
        span.textContent = realState.actionError;
        alertEl.appendChild(span);
        container.appendChild(alertEl);
      }

      if (realState.backendError) {
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
        container.appendChild(errCard);
        return;
      }

      if (realState.loading && realState.jobs.length === 0) {
        const loadingCard = document.createElement("div");
        loadingCard.className = "scan-card";
        const loadingText = document.createElement("p");
        loadingText.className = "scans-subtitle";
        loadingText.textContent = "正在加载服务器扫描任务列表...";
        loadingCard.appendChild(loadingText);
        container.appendChild(loadingCard);
        return;
      }

      if (realState.jobs.length === 0) {
        const emptyCard = document.createElement("div");
        emptyCard.className = "scan-card";
        const emptyText = document.createElement("p");
        emptyText.className = "scans-subtitle";
        emptyText.textContent = "当前服务器扫描配置（scans.json）中未定义任何任务。";
        emptyCard.appendChild(emptyText);
        container.appendChild(emptyCard);
        return;
      }

      const list = document.createElement("div");
      list.className = "scans-list";
      realState.jobs.forEach((job) => {
        list.appendChild(renderRealJobCard(job, realState.allowTrigger));
      });
      container.appendChild(list);
    }

    function renderRealJobCard(job, allowTrigger) {
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
        p.textContent = "服务器正在后台执行 gdu 扫描与快照校验，请稍候；完成后可点击「打开结果」在 Browser 中加载新快照。";
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
      openBtn.className = job.hasSnapshot ? "btn-accent scan-open-result-btn" : "btn-secondary scan-open-result-btn";
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
    createScansView,
  };
});
