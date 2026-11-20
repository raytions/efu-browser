import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const EfuCore = require("../efu-core.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

test("parses realistic Everything 5-column EFU fixture (BOM, Windows/UNC/Linux, dirs, empty file, embedded newline, ISO date)", () => {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, "everything-sample.efu"), "utf8");
  const parsed = EfuCore.parseEfu(raw);

  assert.equal(parsed.entries.length, 6);
  assert.equal(parsed.columns.hasSize, true);
  assert.equal(parsed.columns.hasModified, true);
  assert.equal(parsed.columns.hasCreated, true);
  assert.equal(parsed.columns.hasAttributes, true);

  const xlsx = parsed.entries[0];
  assert.equal(xlsx.fileName, '预算表 "最终版".xlsx');
  assert.equal(xlsx.sizeBig, 24576n);
  assert.equal(EfuCore.formatSize(xlsx), "24.0 KB");
  assert.equal(xlsx.isDirectory, false);

  const dir = parsed.entries[1];
  assert.equal(dir.fileName, "文档, 2026");
  assert.equal(dir.isDirectory, true);
  assert.equal(EfuCore.formatSize(dir), "—");

  const unc = parsed.entries[2];
  assert.equal(unc.path, "\\\\nas\\share\\media\\电影 4K.mkv");
  assert.equal(unc.fileName, "电影 4K.mkv");
  assert.equal(EfuCore.formatSize(unc), "4.00 GB");

  const emptyFile = parsed.entries[3];
  assert.equal(emptyFile.fileName, "empty.txt");
  assert.equal(emptyFile.sizeBig, 0n);
  assert.equal(EfuCore.formatSize(emptyFile), "0 B");

  const multiline = parsed.entries[4];
  assert.equal(multiline.fileName, "line1\nline2.txt");
  assert.equal(multiline.createdBig, null);
  assert.equal(EfuCore.formatFriendlyDate(multiline, "Date Created").date, "—");

  const iso = parsed.entries[5];
  assert.ok(iso.modifiedBig !== null);
  const isoDate = EfuCore.filetimeToDate(iso.modifiedBig);
  assert.equal(isoDate.toISOString(), "2026-11-15T08:30:00.000Z");

  // Search works on UNC paths, Chinese, quotes, and embedded newlines
  const uncSearch = EfuCore.filterAndSortEntries(parsed.entries, { query: "path:\\\\nas\\share" });
  assert.equal(uncSearch.filtered.length, 1);
  assert.equal(uncSearch.filtered[0].fileName, "电影 4K.mkv");

  const newlineSearch = EfuCore.filterAndSortEntries(parsed.entries, { query: "line1*line2" });
  assert.equal(newlineSearch.filtered.length, 1);
  assert.equal(newlineSearch.filtered[0].fileName, "line1\nline2.txt");

  // Directory exclusion toggle
  const filesOnly = EfuCore.filterAndSortEntries(parsed.entries, { includeDirectories: false });
  assert.equal(filesOnly.filtered.length, 5);
});

test("parses Filename-only EFU without fabricating size, date, or attributes", () => {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, "filename-only.efu"), "utf8");
  const parsed = EfuCore.parseEfu(raw);

  assert.equal(parsed.entries.length, 3);
  assert.equal(parsed.columns.hasSize, false);
  assert.equal(parsed.columns.hasModified, false);
  assert.equal(parsed.columns.hasCreated, false);
  assert.equal(parsed.columns.hasAttributes, false);

  for (const entry of parsed.entries) {
    assert.equal(entry.sizeBig, null);
    assert.equal(entry.modifiedBig, null);
    assert.equal(entry.createdBig, null);
    assert.equal(entry.attributeNumber, null);
    assert.equal(EfuCore.formatSize(entry), "—");
    assert.equal(EfuCore.formatFriendlyDate(entry, "Date Modified").date, "—");
    assert.equal(EfuCore.describeAttributes(entry.attributes), "—");
  }

  assert.equal(EfuCore.formatAggregateSize(parsed.entries), "—");
  assert.equal(parsed.entries[1].fileName, "报告, v1.pdf");
  assert.equal(parsed.entries[2].fileName, 'quotes "test".txt');
});

test("parses header-only EFU (empty directory) cleanly as 0 entries", () => {
  const parsed = EfuCore.parseEfu("Filename,Size,Date Modified\r\n");
  assert.equal(parsed.entries.length, 0);
  assert.equal(EfuCore.formatAggregateSize(parsed.entries), "—");
});

test("rejects invalid/corrupt EFU inputs cleanly (HTML 404, missing Filename header, unclosed quote)", () => {
  assert.throws(() => EfuCore.parseEfu("<html><body>404 Not Found</body></html>"), /Filename/);
  assert.throws(() => EfuCore.parseEfu(""), /为空/);
  assert.throws(() => EfuCore.parseEfu('Filename,Size\n"unclosed.txt,123'), /未闭合/);
});

test("validates runtime config URLs for same-origin and subpath compatibility", () => {
  const baseHref = "https://nas.example.local/efu-browser/";
  const normalized = EfuCore.normalizeRuntimeConfig(
    {
      defaultIndex: "projects",
      indexes: [
        { id: "projects", name: "项目库", url: "indexes/projects.efu" },
        { id: "root-rel", name: "根路径", url: "/indexes/media.efu" },
        { id: "bad-cross", name: "跨域", url: "https://evil.example.com/a.efu" },
        { id: "bad-proto", name: "伪协议", url: "javascript:alert(1)" },
      ],
    },
    baseHref
  );

  assert.equal(normalized.indexes.length, 2);
  assert.equal(normalized.defaultIndex, "projects");
  assert.equal(normalized.indexes[0].url, "https://nas.example.local/efu-browser/indexes/projects.efu");
  assert.equal(normalized.indexes[1].url, "https://nas.example.local/indexes/media.efu");
  assert.equal(normalized.warnings.length, 2);
});
