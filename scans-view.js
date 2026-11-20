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

  const STATUS_LABELS = {
    idle: "待扫描（模拟）",
    queued: "等待中（模拟）",
    scanning: "扫描中（模拟）",
    completed: "已完成（模拟）",
  };

  function createScansView({ container, service, onOpenResult }) {
    if (!container || !service) {
      throw new Error("createScansView requires container and service");
    }

    function render(jobs) {
      container.textContent = "";

      if (service.isDemo) {
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
      }

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
        list.appendChild(renderJobCard(job));
      });

      container.appendChild(list);
    }

    function renderJobCard(job) {
      const card = document.createElement("article");
      card.className = "scan-card";
      card.dataset.jobId = job.id;
      card.dataset.status = job.status;

      const isBusy = job.status === "queued" || job.status === "scanning";

      // Top row: job name + path + status pill
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
      statusBadge.textContent = STATUS_LABELS[job.status] || job.status;

      topRow.append(identity, statusBadge);

      // Metadata grid
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

      // Simulated progress section
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

      // Completion notice with suggested search query
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

      // Action buttons
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

    const unsubscribe = service.subscribe((jobs) => {
      render(jobs);
    });

    render(service.listJobs());

    return {
      refresh() {
        render(service.listJobs());
      },
      destroy() {
        unsubscribe();
      },
    };
  }

  return {
    STATUS_LABELS,
    createScansView,
  };
});
