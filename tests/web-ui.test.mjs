import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

const CHROME_BIN = findChromiumBin();

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

    const allowed = new Set(["index.html", "styles.css", "efu-core.js", "app.js"]);
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

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
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

    // Theme switching works (light / dark / mac)
    await page.evaluate(() => {
      document.querySelector('[data-theme-option="dark"]').click();
    });
    const hasDark = await page.evaluate(() => document.documentElement.classList.contains("theme-dark"));
    assert.equal(hasDark, true);
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
