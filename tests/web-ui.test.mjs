import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createScansHttpServer, createScansManager } from "../scripts/scans-service-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function findChromiumBin() {
  for (const bin of [process.env.CHROME_PATH, "/usr/bin/chromium", "/usr/bin/google-chrome", "chromium", "google-chrome"]) {
    if (!bin) continue;
    const res = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (!res.error && res.status === 0) return bin;
  }
  return null;
}

function findGduBin() {
  for (const bin of [process.env.EFU_GDU_BIN, "/home/antigravity/.local/bin/gdu", "gdu"]) {
    if (!bin) continue;
    const res = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (!res.error && res.status === 0) return bin;
  }
  return null;
}

const CHROME_BIN = findChromiumBin();
const GDU_BIN = findGduBin();

async function startBrowser() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-chrome-"));
  const proc = spawn(
    CHROME_BIN,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let stderrBuf = "";
  const wsUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out starting Chromium: ${stderrBuf}`));
    }, 15000);

    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chromium exited early (${code}): ${stderrBuf}`));
    });
  });

  const debugOrigin = new URL(wsUrl).origin.replace(/^ws:/, "http:");

  return {
    debugOrigin,
    async newPage() {
      const target = await (await fetch(`${debugOrigin}/json/new?about:blank`, { method: "PUT" })).json();
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
      });

      let msgId = 0;
      const pending = new Map();
      const consoleErrors = [];

      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method === "Runtime.exceptionThrown") {
          consoleErrors.push(msg.params?.exceptionDetails?.text || "Runtime exception");
        }
      });

      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++msgId;
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        });

      await send("Page.enable");
      await send("Runtime.enable");

      return {
        consoleErrors,
        async goto(url) {
          await send("Page.navigate", { url });
          await this.waitFor(() => document.readyState === "complete");
        },
        async evaluate(fn, ...args) {
          const expression =
            typeof fn === "string"
              ? fn
              : `(${fn.toString()})(...${JSON.stringify(args)})`;
          const res = await send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          if (res.exceptionDetails) {
            throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
          }
          return res.result?.value;
        },
        async waitFor(predicateFn, timeoutMs = 8000) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const ok = await this.evaluate(predicateFn);
            if (ok) return true;
            await new Promise((r) => setTimeout(r, 30));
          }
          throw new Error(`waitFor timed out after ${timeoutMs}ms`);
        },
        async close() {
          try {
            ws.close();
          } catch {
            // ignore
          }
          await fetch(`${debugOrigin}/json/close/${target.id}`).catch(() => {});
        },
      };
    },
    async close() {
      proc.kill("SIGTERM");
      await new Promise((resolve) => proc.once("exit", resolve));
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

function createTestServer(handlers) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, "http://127.0.0.1");
    requests.push(urlObj.pathname);

    if (handlers.custom && (await handlers.custom(urlObj.pathname, req, res))) {
      return;
    }

    const prefix = handlers.basePath || "/";
    let relPath = urlObj.pathname;
    if (prefix !== "/" && relPath.startsWith(prefix)) {
      relPath = relPath.slice(prefix.length);
    } else if (relPath.startsWith("/")) {
      relPath = relPath.slice(1);
    }
    if (!relPath || relPath === "/") relPath = "index.html";

    const allowed = new Set([
      "index.html",
      "styles.css",
      "efu-core.js",
      "scans-demo-service.js",
      "scans-real-service.js",
      "scans-view.js",
      "app.js",
    ]);
    if (allowed.has(relPath)) {
      const ext = path.extname(relPath);
      const mime =
        ext === ".html"
          ? "text/html; charset=utf-8"
          : ext === ".css"
            ? "text/css; charset=utf-8"
            : "application/javascript; charset=utf-8";
      res.writeHead(200, { "Content-Type": mime });
      res.end(fs.readFileSync(path.join(REPO_ROOT, relPath)));
      return;
    }

    if (relPath === "demo/demo-before.efu" || relPath === "demo/demo-after.efu") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(fs.readFileSync(path.join(REPO_ROOT, relPath)));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(r);
          }),
      });
    });
  });
}

test("Web UI static mode (empty config): makes zero EFU requests, shows zero errors, supports local file import and themes", { skip: !CHROME_BIN }, async () => {
  const srv = await createTestServer({
    basePath: "/efu-browser/",
    custom: async (pathname, _req, res) => {
      if (pathname === "/efu-browser/config.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ indexes: [] }));
        return true;
      }
      return false;
    },
  });

  const browser = await startBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(`${srv.origin}/efu-browser/`);
    await page.waitFor(() => Boolean(window.__efuApp));
    await new Promise((r) => setTimeout(r, 200));

    // No .efu requests should be made when no server indexes are configured
    const efuRequests = srv.requests.filter((p) => p.endsWith(".efu") || p.includes("/efu/"));
    assert.deepEqual(efuRequests, []);

    const initialState = await page.evaluate(() => ({
      bannerHidden: document.getElementById("status-banner").classList.contains("hidden"),
      serverBarHidden: document.getElementById("server-index-bar").classList.contains("hidden"),
      activeSource: document.getElementById("active-source").textContent,
    }));
    assert.equal(initialState.bannerHidden, true);
    assert.equal(initialState.serverBarHidden, true);
    assert.equal(initialState.activeSource, "尚未加载");
    assert.deepEqual(page.consoleErrors, []);

    // Manual local file upload via File input + DataTransfer (also tests XSS text-only rendering)
    await page.evaluate(() => {
      const efu =
        'Filename,Size,Date Modified\r\n' +
        '"/mnt/nas/<img src=x onerror=""window.__xss=1"">.txt",1024,134000000000000000\r\n';
      const file = new File([efu], "manual-test.efu", { type: "text/plain" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById("file-upload");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await page.waitFor(() => document.getElementById("active-source").textContent === "manual-test.efu");
    const manualCheck = await page.evaluate(() => ({
      rows: document.querySelectorAll("#results tr").length,
      firstName: document.querySelector("#results td.col-file")?.textContent,
      xss: window.__xss,
      linksInTable: document.querySelectorAll("#results a").length,
    }));
    assert.equal(manualCheck.rows, 1);
    assert.equal(manualCheck.firstName, '<img src=x onerror="window.__xss=1">.txt');
    assert.equal(manualCheck.xss, undefined);
    assert.equal(manualCheck.linksInTable, 0);

    // Theme switching stays in Settings (system / light / dark, no macOS or top-bar quick toggle)
    const themeCheck = await page.evaluate(() => {
      const hasQuickToggle = Boolean(document.getElementById("theme-quick-toggle"));
      const options = Array.from(document.querySelectorAll("[data-theme-option]")).map(
        (el) => el.dataset.themeOption
      );
      document.querySelector('[data-theme-option="dark"]').click();
      const darkApplied = document.documentElement.classList.contains("theme-dark");
      document.querySelector('[data-theme-option="light"]').click();
      const lightApplied = document.documentElement.classList.contains("theme-light");
      document.querySelector('[data-theme-option="system"]').click();
      const systemStored = document.documentElement.dataset.themeChoice;
      return { hasQuickToggle, options, darkApplied, lightApplied, systemStored };
    });
    assert.equal(themeCheck.hasQuickToggle, false);
    assert.deepEqual(themeCheck.options, ["system", "light", "dark"]);
    assert.equal(themeCheck.darkApplied, true);
    assert.equal(themeCheck.lightApplied, true);
    assert.equal(themeCheck.systemStored, "system");
  } finally {
    await page.close();
    await browser.close();
    await srv.close();
  }
});

test("Web UI server indexes on subpath: auto-load, switch, reload updated snapshot, preserve on error, and guard rapid-switch race", { skip: !CHROME_BIN }, async () => {
  let alphaVersion = 1;
  let alphaLastModified = "Wed, 18 Nov 2026 10:00:00 GMT";

  const srv = await createTestServer({
    basePath: "/nas-search/",
    custom: async (pathname, _req, res) => {
      if (pathname === "/nas-search/config.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            defaultIndex: "alpha",
            indexes: [
              { id: "alpha", name: "项目归档", url: "indexes/alpha.efu" },
              { id: "slow", name: "慢速归档", url: "indexes/slow.efu" },
              { id: "fast", name: "快速归档", url: "indexes/fast.efu" },
              { id: "broken-http", name: "故障索引", url: "indexes/broken.efu" },
              { id: "corrupt-efu", name: "损坏快照", url: "indexes/corrupt.efu" },
            ],
          })
        );
        return true;
      }

      if (pathname === "/nas-search/indexes/alpha.efu") {
        const body =
          alphaVersion === 1
            ? "Filename,Size,Date Modified\r\n/mnt/nas/projects/v1-alpha.txt,100,134000000000000000\r\n"
            : "Filename,Size,Date Modified\r\n/mnt/nas/projects/v2-updated.txt,2048,134050000000000000\r\n";
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Last-Modified": alphaLastModified,
          "Cache-Control": "no-cache",
        });
        res.end(body);
        return true;
      }

      if (pathname === "/nas-search/indexes/slow.efu") {
        await new Promise((r) => setTimeout(r, 350));
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Filename,Size,Date Modified\r\n/mnt/nas/slow/stale-slow.txt,10,134000000000000000\r\n");
        return true;
      }

      if (pathname === "/nas-search/indexes/fast.efu") {
        await new Promise((r) => setTimeout(r, 15));
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Filename,Size,Date Modified\r\n/mnt/nas/fast/winner-fast.txt,55,134000000000000000\r\n");
        return true;
      }

      if (pathname === "/nas-search/indexes/broken.efu") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
        return true;
      }

      if (pathname === "/nas-search/indexes/corrupt.efu") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body>Not an EFU file</body></html>");
        return true;
      }

      return false;
    },
  });

  const browser = await startBrowser();
  const page = await browser.newPage();
  try {
    // 1. Subpath auto-load & Last-Modified badge
    await page.goto(`${srv.origin}/nas-search/`);
    await page.waitFor(
      () => document.querySelector("#results td.col-file")?.textContent === "v1-alpha.txt"
    );

    const loadedAlpha = await page.evaluate(() => ({
      source: document.getElementById("active-source").textContent,
      snapshotBadge: document.getElementById("snapshot-modified").textContent,
      serverBarVisible: !document.getElementById("server-index-bar").classList.contains("hidden"),
    }));
    assert.equal(loadedAlpha.source, "项目归档");
    assert.equal(loadedAlpha.serverBarVisible, true);
    assert.match(loadedAlpha.snapshotBadge, /^快照修改时间：/);

    // 2. Reload picks up newly atomically published snapshot
    alphaVersion = 2;
    alphaLastModified = "Thu, 19 Nov 2026 15:30:00 GMT";
    await page.evaluate(() => document.getElementById("reload-server-index").click());
    await page.waitFor(
      () => document.querySelector("#results td.col-file")?.textContent === "v2-updated.txt"
    );

    // 3. HTTP 500 failure keeps previous results intact and shows readable error banner
    await page.evaluate(() => {
      const sel = document.getElementById("server-index-select");
      sel.value = "broken-http";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitFor(() => !document.getElementById("status-banner").classList.contains("hidden"));
    const afterHttpError = await page.evaluate(() => ({
      bannerText: document.getElementById("status-banner-text").textContent,
      firstFile: document.querySelector("#results td.col-file")?.textContent,
      source: document.getElementById("active-source").textContent,
    }));
    assert.match(afterHttpError.bannerText, /HTTP 500/);
    assert.equal(afterHttpError.firstFile, "v2-updated.txt");
    assert.equal(afterHttpError.source, "项目归档");

    // 4. Corrupt EFU parse failure keeps previous results intact
    await page.evaluate(() => {
      const sel = document.getElementById("server-index-select");
      sel.value = "corrupt-efu";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitFor(() =>
      document.getElementById("status-banner-text").textContent.includes("Filename")
    );
    const afterParseError = await page.evaluate(() => ({
      firstFile: document.querySelector("#results td.col-file")?.textContent,
      source: document.getElementById("active-source").textContent,
    }));
    assert.equal(afterParseError.firstFile, "v2-updated.txt");
    assert.equal(afterParseError.source, "项目归档");

    // 5. Rapid switching race condition: start slow (350ms), immediately switch to fast (15ms)
    await page.evaluate(() => {
      const sel = document.getElementById("server-index-select");
      sel.value = "slow";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      sel.value = "fast";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitFor(
      () => document.querySelector("#results td.col-file")?.textContent === "winner-fast.txt"
    );
    // Wait past slow.efu's 350ms latency to prove late response does NOT overwrite winner-fast.txt
    await new Promise((r) => setTimeout(r, 500));
    const afterRace = await page.evaluate(() => ({
      firstFile: document.querySelector("#results td.col-file")?.textContent,
      source: document.getElementById("active-source").textContent,
    }));
    assert.equal(afterRace.firstFile, "winner-fast.txt");
    assert.equal(afterRace.source, "快速归档");
    assert.deepEqual(page.consoleErrors, []);
  } finally {
    await page.close();
    await browser.close();
    await srv.close();
  }
});

test("Web UI Scans demo on /efu-browser/ subpath: direct link + reload, simulated scan guard, preserves open Browser EFU, opens demo-after.efu and finds demo-slide-003.svs", { skip: !CHROME_BIN }, async () => {
  const srv = await createTestServer({
    basePath: "/efu-browser/",
    custom: async (pathname, _req, res) => {
      if (pathname === "/efu-browser/config.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ indexes: [] }));
        return true;
      }
      return false;
    },
  });

  const browser = await startBrowser();
  const page = await browser.newPage();
  try {
    // 1. Direct entry to Scans on GitHub Pages subpath (#/scans) and refresh works
    await page.goto(`${srv.origin}/efu-browser/#/scans`);
    await page.waitFor(() => Boolean(window.__efuApp));

    const directScans = await page.evaluate(() => ({
      scansVisible: !document.getElementById("scans-view").classList.contains("hidden"),
      browserHidden: document.getElementById("browser-view").classList.contains("hidden"),
      demoBadge: document.querySelector("#scans-view .scans-demo-badge")?.textContent,
      demoDesc: document.querySelector("#scans-view .scans-demo-desc")?.textContent,
      jobTitle: document.querySelector(".scan-card h3")?.textContent,
    }));
    assert.equal(directScans.scansVisible, true);
    assert.equal(directScans.browserHidden, true);
    assert.equal(directScans.demoBadge, "演示模式");
    assert.equal(directScans.demoDesc, "这是模拟扫描，不会访问你的设备、服务器或 NAS。");
    assert.equal(directScans.jobTitle, "Example NAS");

    // Reload on #/scans stays on Scans
    await page.evaluate(() => window.location.reload());
    await page.waitFor(() => Boolean(window.__efuApp) && !document.getElementById("scans-view").classList.contains("hidden"));

    // 2. Switch to Browser, open user's own local EFU first
    await page.evaluate(() => document.getElementById("nav-browser").click());
    await page.waitFor(() => !document.getElementById("browser-view").classList.contains("hidden"));

    await page.evaluate(() => {
      const customEfu =
        "Filename,Size,Date Modified\r\n" +
        "/home/user/private-doc.txt,512,134000000000000000\r\n";
      const file = new File([customEfu], "my-private.efu", { type: "text/plain" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById("file-upload");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitFor(() => document.getElementById("active-source").textContent === "my-private.efu");

    // 3. Switch back to Scans, trigger simulated scan, verify disabled button & duplicate-start block
    await page.evaluate(() => document.getElementById("nav-scans").click());
    await page.waitFor(() => !document.getElementById("scans-view").classList.contains("hidden"));

    const duringScan = await page.evaluate(() => {
      const btn = document.querySelector('[data-action="start-scan"]');
      btn.click();
      const afterClickBtn = document.querySelector('[data-action="start-scan"]');
      const dupAttempt = window.__efuApp.getScansService().startScan("example-nas");
      return {
        disabled: afterClickBtn.disabled,
        status: document.querySelector(".scan-card")?.dataset.status,
        dupAttempt,
      };
    });
    assert.equal(duringScan.disabled, true);
    assert.equal(duringScan.status, "queued");
    assert.deepEqual(duringScan.dupAttempt, { started: false, reason: "already_running" });

    // 4. Wait for simulated scan completion
    await page.waitFor(
      () => document.querySelector(".scan-card")?.dataset.status === "completed",
      6000
    );

    const afterComplete = await page.evaluate(() => ({
      openBtnVisible: Boolean(document.querySelector('[data-action="open-result"]')),
      completionText: document.querySelector(".scan-completion-note")?.textContent,
      // Browser's open EFU MUST NOT be overwritten before clicking "打开结果"
      browserActiveSource: document.getElementById("active-source").textContent,
      browserFirstFile: document.querySelector("#results td.col-file")?.textContent,
    }));
    assert.equal(afterComplete.openBtnVisible, true);
    assert.match(afterComplete.completionText, /demo-slide-003\.svs/);
    assert.equal(afterComplete.browserActiveSource, "my-private.efu");
    assert.equal(afterComplete.browserFirstFile, "private-doc.txt");

    // 5. Click "打开结果" -> switches to Browser, loads demo/demo-after.efu, existing search finds demo-slide-003.svs
    await page.evaluate(() => document.querySelector('[data-action="open-result"]').click());
    await page.waitFor(
      () =>
        !document.getElementById("browser-view").classList.contains("hidden") &&
        document.getElementById("total-count").textContent === "6"
    );

    const afterOpen = await page.evaluate(() => ({
      hash: window.location.hash,
      activeSource: document.getElementById("active-source").textContent,
      totalCount: document.getElementById("total-count").textContent,
      demoHintText: document.getElementById("demo-hint-text").textContent,
    }));
    assert.equal(afterOpen.hash, "#/browser");
    assert.match(afterOpen.activeSource, /Example NAS/);
    assert.equal(afterOpen.totalCount, "6");
    assert.match(afterOpen.demoHintText, /demo-slide-003\.svs/);

    // Use existing search input to find demo-slide-003.svs
    await page.evaluate(() => {
      const input = document.getElementById("search-input");
      input.value = "demo-slide-003.svs";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitFor(() => document.getElementById("filtered-count").textContent === "1");

    const searchRes = await page.evaluate(() => ({
      matchedFile: document.querySelector("#results td.col-file")?.textContent,
      matchedPath: document.querySelector("#results td.col-path")?.textContent,
      clearVisibleWhenFilled: getComputedStyle(document.getElementById("clear-search")).visibility,
    }));
    assert.equal(searchRes.matchedFile, "demo-slide-003.svs");
    assert.equal(searchRes.matchedPath, "/mnt/example-nas/demo-archive/slides/demo-slide-003.svs");
    assert.equal(searchRes.clearVisibleWhenFilled, "visible");

    // Clicking custom clear button empties input and hides the button again
    await page.evaluate(() => document.getElementById("clear-search").click());
    await page.waitFor(() => document.getElementById("filtered-count").textContent === "6");
    const clearHiddenWhenEmpty = await page.evaluate(
      () => getComputedStyle(document.getElementById("clear-search")).visibility
    );
    assert.equal(clearHiddenWhenEmpty, "hidden");

    // 6. Demo "添加扫描目标" uses fictional directory tree only and NEVER calls /api/*
    await page.evaluate(() => document.getElementById("nav-scans").click());
    await page.waitFor(() => Boolean(document.querySelector('[data-action="open-add-target"]')));
    await page.evaluate(() => document.querySelector('[data-action="open-add-target"]').click());
    await page.waitFor(() => Boolean(document.querySelector('.scan-dir-item[data-entry-name="datasets"]')));
    await page.evaluate(() => document.querySelector('.scan-dir-item[data-entry-name="datasets"]').click());
    await page.waitFor(() =>
      document.querySelector("[data-selected-root-path]")?.dataset.selectedRootPath === "/mnt/example-nas/datasets"
    );
    await page.evaluate(() => {
      const nameInput = document.querySelector('input[name="taskName"]');
      const outInput = document.querySelector('input[name="outputName"]');
      nameInput.value = "虚构数据集";
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      outInput.value = "demo-datasets.efu";
      outInput.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector('[data-action="submit-create-task"]').click();
    });
    await page.waitFor(() => document.querySelectorAll(".scan-card").length === 2);

    // Confirm demo-after.efu was fetched under /efu-browser/ subpath and demo mode NEVER called /api/*
    assert.ok(srv.requests.includes("/efu-browser/demo/demo-after.efu"));
    assert.deepEqual(
      srv.requests.filter((p) => p.includes("/api/")),
      []
    );
    assert.deepEqual(page.consoleErrors, []);
  } finally {
    await page.close();
    await browser.close();
    await srv.close();
  }
});

test("Web UI Real Mode end-to-end: lists real task, triggers gdu scan, preserves open Browser EFU until Open Result, loads /indexes/projects.efu and finds new file", { skip: !CHROME_BIN || !GDU_BIN }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-web-real-"));
  const allowedRoot = path.join(workDir, "nas");
  const rootDir = path.join(allowedRoot, "projects");
  const indexDir = path.join(workDir, "indexes");
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "docs", "季度汇总 2026.pdf"), "real-scan-payload");

  const manager = createScansManager({
    indexDir,
    allowTrigger: true,
    gduBin: GDU_BIN,
    logger: { log() {}, warn() {}, error() {} },
    tasks: [
      {
        id: "projects",
        name: "NAS 项目目录",
        root: rootDir,
        allowedRoot,
        mountPoint: null,
        excludes: [".snapshot"],
        exportPrefix: "\\\\nas\\projects",
        outputName: "projects.efu",
        enabled: true,
        schedule: "0 3 * * *",
      },
    ],
  });

  const apiServer = createScansHttpServer(manager, { apiBase: "/api/scans" });
  const apiListening = await new Promise((resolve) => {
    apiServer.listen(0, "127.0.0.1", () => {
      const { port } = apiServer.address();
      resolve({ origin: `http://127.0.0.1:${port}` });
    });
  });

  const srv = await createTestServer({
    basePath: "/",
    custom: async (pathname, req, res) => {
      if (pathname === "/config.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            indexes: [],
            scans: { mode: "real", apiBase: "/api/scans" },
          })
        );
        return true;
      }

      if (pathname.startsWith("/api/scans")) {
        const upstream = await fetch(`${apiListening.origin}${req.url}`, {
          method: req.method,
        });
        const body = await upstream.text();
        res.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") || "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
        return true;
      }

      if (pathname.startsWith("/indexes/")) {
        const fileName = path.basename(pathname);
        const full = path.join(indexDir, fileName);
        if (fileName.endsWith(".efu") && fs.existsSync(full)) {
          const stat = fs.statSync(full);
          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Last-Modified": stat.mtime.toUTCString(),
            "Cache-Control": "no-cache",
          });
          res.end(fs.readFileSync(full));
          return true;
        }
        res.writeHead(404);
        res.end("Not Found");
        return true;
      }

      return false;
    },
  });

  const browser = await startBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(`${srv.origin}/`);
    await page.waitFor(() => Boolean(window.__efuApp) && window.__efuApp.state.scansMode === "real");

    // 1. Open user's own local EFU in Browser first
    await page.evaluate(() => {
      const localEfu = "Filename,Size,Date Modified\r\n/local/keep-me.txt,123,134000000000000000\r\n";
      const file = new File([localEfu], "keep-local.efu", { type: "text/plain" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById("file-upload");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitFor(() => document.getElementById("active-source").textContent === "keep-local.efu");

    // 2. Navigate to Scans -> verify Real Mode banner & real task list (no demo mode)
    await page.evaluate(() => document.getElementById("nav-scans").click());
    await page.waitFor(
      () => Boolean(document.querySelector(".scans-real-badge")) && Boolean(document.querySelector(".scan-card h3"))
    );

    const realInitial = await page.evaluate(() => ({
      navPill: document.getElementById("nav-scans-pill").textContent,
      realBadge: document.querySelector(".scans-real-badge")?.textContent,
      hasDemoBanner: Boolean(document.querySelector(".scans-demo-banner")),
      taskTitle: document.querySelector(".scan-card h3")?.textContent,
    }));
    assert.equal(realInitial.navPill, "真实");
    assert.equal(realInitial.realBadge, "真实模式");
    assert.equal(realInitial.hasDemoBanner, false);
    assert.equal(realInitial.taskTitle, "NAS 项目目录");

    // 3. Trigger real scan via UI
    await page.evaluate(() => document.querySelector('[data-action="start-scan"]').click());
    await page.waitFor(
      () => document.querySelector(".scan-card")?.dataset.status === "succeeded",
      10000
    );

    // 4. Verify Browser's existing local EFU was NOT overwritten automatically after real scan finished
    const beforeOpenResult = await page.evaluate(() => ({
      activeSource: document.getElementById("active-source").textContent,
      firstFile: document.querySelector("#results td.col-file")?.textContent,
      openDisabled: document.querySelector('[data-action="open-result"]')?.disabled,
    }));
    assert.equal(beforeOpenResult.activeSource, "keep-local.efu");
    assert.equal(beforeOpenResult.firstFile, "keep-me.txt");
    assert.equal(beforeOpenResult.openDisabled, false);

    // 5. Click "打开结果" -> loads /indexes/projects.efu and existing search finds 季度汇总 2026.pdf
    await page.evaluate(() => document.querySelector('[data-action="open-result"]').click());
    await page.waitFor(
      () =>
        !document.getElementById("browser-view").classList.contains("hidden") &&
        document.getElementById("active-source").textContent === "NAS 项目目录"
    );

    await page.evaluate(() => {
      const input = document.getElementById("search-input");
      input.value = "季度汇总";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitFor(() => document.getElementById("filtered-count").textContent === "1");

    const found = await page.evaluate(() => ({
      fileName: document.querySelector("#results td.col-file")?.textContent,
      fullPath: document.querySelector("#results td.col-path")?.textContent,
    }));
    assert.equal(found.fileName, "季度汇总 2026.pdf");
    assert.equal(found.fullPath, "\\\\nas\\projects\\docs\\季度汇总 2026.pdf");

    // 6. If loading a real EFU fails (e.g. deleted/500), Browser keeps existing results intact
    fs.unlinkSync(path.join(indexDir, "projects.efu"));
    await page.evaluate(() => window.__efuApp.openScanResult({
      type: "real",
      jobId: "projects",
      url: "/indexes/projects.efu",
      label: "NAS 项目目录",
    }));
    await page.waitFor(() => !document.getElementById("status-banner").classList.contains("hidden"));
    const afterLoadErr = await page.evaluate(() => ({
      banner: document.getElementById("status-banner-text").textContent,
      preservedFile: document.querySelector("#results td.col-file")?.textContent,
      preservedSource: document.getElementById("active-source").textContent,
    }));
    assert.match(afterLoadErr.banner, /HTTP 404/);
    assert.equal(afterLoadErr.preservedFile, "季度汇总 2026.pdf");
    assert.equal(afterLoadErr.preservedSource, "NAS 项目目录");

    // 7. Direct refresh on #/scans stays in Real Mode
    await page.goto(`${srv.origin}/#/scans`);
    await page.waitFor(() => Boolean(document.querySelector(".scans-real-badge")));
    await page.evaluate(() => window.location.reload());
    await page.waitFor(() => Boolean(document.querySelector(".scans-real-badge")));

    assert.deepEqual(page.consoleErrors, []);
  } finally {
    manager.shutdown();
    apiServer.closeAllConnections?.();
    await new Promise((r) => apiServer.close(r));
    await page.close();
    await browser.close();
    await srv.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("Web UI Real Mode shows readable error when backend is unavailable and never falls back to Demo mode", { skip: !CHROME_BIN }, async () => {
  const srv = await createTestServer({
    basePath: "/",
    custom: async (pathname, _req, res) => {
      if (pathname === "/config.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            indexes: [],
            scans: { mode: "real", apiBase: "/api/scans" },
          })
        );
        return true;
      }
      if (pathname.startsWith("/api/scans")) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Gateway" }));
        return true;
      }
      return false;
    },
  });

  const browser = await startBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(`${srv.origin}/#/scans`);
    await page.waitFor(() => Boolean(document.querySelector(".scan-error-card")));

    const errState = await page.evaluate(() => ({
      realBadge: document.querySelector(".scans-real-badge")?.textContent,
      hasDemoBanner: Boolean(document.querySelector(".scans-demo-banner")),
      errorHeading: document.querySelector(".scan-error-card h3")?.textContent,
      errorBody: document.querySelector(".scan-error-card")?.textContent,
      hasExampleNas: document.getElementById("scans-view").textContent.includes("Example NAS"),
    }));
    assert.equal(errState.realBadge, "真实模式");
    assert.equal(errState.hasDemoBanner, false);
    assert.match(errState.errorHeading, /无法连接/);
    assert.match(errState.errorBody, /不会回退到演示模式/);
    assert.equal(errState.hasExampleNas, false);
    assert.deepEqual(page.consoleErrors, []);
  } finally {
    await page.close();
    await browser.close();
    await srv.close();
  }
});

test("Web UI Real Mode directory picker E2E: pick subdir under allowedRoots, create task, trigger gdu scan, open result in Browser, and delete definition keeping EFU", { skip: !CHROME_BIN || !GDU_BIN }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-web-picker-"));
  const nasRoot = path.join(workDir, "nas");
  const labSubdir = path.join(nasRoot, "pathology", "batch-2026");
  const indexDir = path.join(workDir, "indexes");
  const tasksFile = path.join(workDir, "config", "scans.json");

  fs.mkdirSync(labSubdir, { recursive: true });
  fs.mkdirSync(path.join(labSubdir, ".snapshot"), { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(labSubdir, "slide-999.svs"), "whole-slide-image-bytes");
  fs.writeFileSync(path.join(labSubdir, ".snapshot", "skip.svs"), "ignored");

  const manager = createScansManager({
    tasksFile,
    indexDir,
    allowedRoots: [nasRoot],
    allowTrigger: true,
    allowManage: true,
    gduBin: GDU_BIN,
    logger: { log() {}, warn() {}, error() {} },
  });

  const apiServer = createScansHttpServer(manager, { apiBase: "/api/scans" });
  const apiListening = await new Promise((resolve) => {
    apiServer.listen(0, "127.0.0.1", () => {
      const { port } = apiServer.address();
      resolve({ origin: `http://127.0.0.1:${port}` });
    });
  });

  const srv = await createTestServer({
    basePath: "/",
    custom: async (pathname, req, res) => {
      if (pathname === "/config.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            indexes: [],
            scans: { mode: "real", apiBase: "/api/scans" },
          })
        );
        return true;
      }

      if (pathname.startsWith("/api/scans") || pathname.startsWith("/api/scan-roots")) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const rawBody = Buffer.concat(chunks);
        const fetchInit = {
          method: req.method,
          headers: req.headers["content-type"]
            ? { "Content-Type": req.headers["content-type"] }
            : undefined,
        };
        if (req.method !== "GET" && req.method !== "HEAD" && rawBody.length > 0) {
          fetchInit.body = rawBody;
        }
        const upstream = await fetch(`${apiListening.origin}${req.url}`, fetchInit);
        const body = await upstream.text();
        res.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") || "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
        return true;
      }

      if (pathname.startsWith("/indexes/")) {
        const fileName = path.basename(pathname);
        const full = path.join(indexDir, fileName);
        if (fileName.endsWith(".efu") && fs.existsSync(full)) {
          const stat = fs.statSync(full);
          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Last-Modified": stat.mtime.toUTCString(),
            "Cache-Control": "no-cache",
          });
          res.end(fs.readFileSync(full));
          return true;
        }
        res.writeHead(404);
        res.end("Not Found");
        return true;
      }

      return false;
    },
  });

  const browser = await startBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(`${srv.origin}/#/scans`);
    await page.waitFor(
      () =>
        Boolean(window.__efuApp) &&
        Boolean(document.querySelector('[data-action="open-add-target"]')) &&
        !document.querySelector('[data-action="open-add-target"]').disabled
    );

    // 1. Open directory picker -> browse pathology -> batch-2026
    await page.evaluate(() => document.querySelector('[data-action="open-add-target"]').click());
    await page.waitFor(() => Boolean(document.querySelector('.scan-dir-item[data-entry-name="pathology"]')));

    await page.evaluate(() => document.querySelector('.scan-dir-item[data-entry-name="pathology"]').click());
    await page.waitFor(() => Boolean(document.querySelector('.scan-dir-item[data-entry-name="batch-2026"]')));

    await page.evaluate(() => document.querySelector('.scan-dir-item[data-entry-name="batch-2026"]').click());
    await page.waitFor(
      () =>
        document.querySelector("[data-selected-root-path]")?.dataset.selectedRootPath?.endsWith("/pathology/batch-2026")
    );

    // 2. Fill task config & save via POST /api/scans
    await page.evaluate(() => {
      const setVal = (sel, val) => {
        const el = document.querySelector(sel);
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      setVal('input[name="taskName"]', "病理批次 2026");
      setVal('input[name="outputName"]', "pathology-2026.efu");
      setVal('input[name="excludes"]', ".snapshot, @eaDir");
      setVal('input[name="exportPrefix"]', "\\\\nas\\pathology\\batch-2026");
      document.querySelector('[data-action="submit-create-task"]').click();
    });

    await page.waitFor(() => Boolean(document.querySelector('.scan-card[data-job-id="pathology-2026"]')));

    const cardInfo = await page.evaluate(() => {
      const card = document.querySelector('.scan-card[data-job-id="pathology-2026"]');
      return {
        title: card?.querySelector("h3")?.textContent,
        pathText: card?.querySelector(".scan-path")?.textContent,
        text: card?.textContent || "",
      };
    });
    assert.equal(cardInfo.title, "病理批次 2026");
    assert.equal(cardInfo.pathText, labSubdir);
    assert.match(cardInfo.text, /\.snapshot/);
    assert.match(cardInfo.text, /pathology-2026\.efu/);

    // 3. Trigger real gdu scan & wait for succeeded
    await page.evaluate(() =>
      document.querySelector('.scan-card[data-job-id="pathology-2026"] [data-action="start-scan"]').click()
    );
    await page.waitFor(
      () => document.querySelector('.scan-card[data-job-id="pathology-2026"]')?.dataset.status === "succeeded",
      10000
    );

    // 4. Open result -> loads /indexes/pathology-2026.efu -> Browser search finds slide-999.svs
    await page.evaluate(() =>
      document.querySelector('.scan-card[data-job-id="pathology-2026"] [data-action="open-result"]').click()
    );
    await page.waitFor(
      () =>
        !document.getElementById("browser-view").classList.contains("hidden") &&
        document.getElementById("active-source").textContent === "病理批次 2026"
    );

    await page.evaluate(() => {
      const input = document.getElementById("search-input");
      input.value = "slide-999";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitFor(() => document.getElementById("filtered-count").textContent === "1");

    const searchResult = await page.evaluate(() => ({
      fileName: document.querySelector("#results td.col-file")?.textContent,
      fullPath: document.querySelector("#results td.col-path")?.textContent,
    }));
    assert.equal(searchResult.fileName, "slide-999.svs");
    assert.equal(searchResult.fullPath, "\\\\nas\\pathology\\batch-2026\\slide-999.svs");

    // 5. Switch back to Scans -> delete task definition (2-step inline confirm) -> EFU file stays on disk
    await page.evaluate(() => document.getElementById("nav-scans").click());
    await page.waitFor(() => Boolean(document.querySelector('[data-action="delete-task"]')));
    await page.evaluate(() => document.querySelector('[data-action="delete-task"]').click());
    await page.waitFor(() => Boolean(document.querySelector('[data-action="confirm-delete-task"]')));
    await page.evaluate(() => document.querySelector('[data-action="confirm-delete-task"]').click());
    await page.waitFor(() => !document.querySelector('.scan-card[data-job-id="pathology-2026"]'));

    assert.equal(fs.existsSync(path.join(indexDir, "pathology-2026.efu")), true);
    assert.deepEqual(page.consoleErrors, []);
  } finally {
    manager.shutdown();
    apiServer.closeAllConnections?.();
    await new Promise((r) => apiServer.close(r));
    await page.close();
    await browser.close();
    await srv.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});


