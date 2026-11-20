import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  formatExportPath,
  parseMountinfo,
  runScanToEfu,
  verifyRequiredMount,
} from "../scripts/efu-scan-lib.mjs";

const require = createRequire(import.meta.url);
const EfuCore = require("../efu-core.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../scripts/efu-scan.mjs");

function findGduBin() {
  const candidates = [
    process.env.EFU_GDU_BIN,
    "/home/antigravity/.local/bin/gdu",
    "gdu",
  ].filter(Boolean);
  for (const bin of candidates) {
    const res = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (!res.error && res.status === 0) {
      return bin;
    }
  }
  return null;
}

const GDU_BIN = findGduBin();

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listTempFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

test("export-prefix preserves directory boundaries for Linux and Windows UNC paths", () => {
  assert.equal(
    formatExportPath("/mnt/nas/projects/a/b.txt", "/mnt/nas/projects", "\\\\nas\\projects"),
    "\\\\nas\\projects\\a\\b.txt"
  );
  assert.equal(
    formatExportPath("/mnt/nas/projects/中文 目录/a, \"b\".txt", "/mnt/nas/projects", "\\\\nas\\projects\\"),
    '\\\\nas\\projects\\中文 目录\\a, "b".txt'
  );
  assert.equal(
    formatExportPath("/mnt/nas/projects/sub/file.txt", "/mnt/nas/projects", "/share/projects"),
    "/share/projects/sub/file.txt"
  );
  // Directory boundary check: /mnt/nas/projects2 must NOT match /mnt/nas/projects
  assert.throws(
    () => formatExportPath("/mnt/nas/projects2/a.txt", "/mnt/nas/projects", "\\\\nas\\projects"),
    /越界/
  );
});

test("mountinfo verification parses octal escapes and enforces actual mountpoint + directory boundary", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-mount-test-"));
  try {
    const nasMount = path.join(tmpDir, "mnt", "nas");
    const nasProjects = path.join(nasMount, "projects");
    const nasSibling = path.join(tmpDir, "mnt", "nas2");
    fs.mkdirSync(nasProjects, { recursive: true });
    fs.mkdirSync(nasSibling, { recursive: true });

    const realMount = fs.realpathSync(nasMount);
    const mountinfoPath = path.join(tmpDir, "mountinfo");
    fs.writeFileSync(
      mountinfoPath,
      [
        `22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw`,
        `99 22 0:45 / ${realMount} ro,relatime - cifs //nas/share ro`,
        `100 22 0:46 / /mnt/with\\040space ro - nfs4 server:/export ro`,
      ].join("\n"),
      "utf8"
    );

    const parsed = parseMountinfo(fs.readFileSync(mountinfoPath, "utf8"));
    assert.ok(parsed.has(realMount));
    assert.ok(parsed.has("/mnt/with space"));

    // Valid: root inside mounted point, and root equal to mount point
    assert.doesNotThrow(() =>
      verifyRequiredMount({ requireMount: nasMount, scanRoot: nasProjects, mountinfoPath })
    );
    assert.doesNotThrow(() =>
      verifyRequiredMount({ requireMount: nasMount, scanRoot: nasMount, mountinfoPath })
    );

    // Invalid: sibling directory /mnt/nas2 is NOT inside /mnt/nas
    assert.throws(
      () => verifyRequiredMount({ requireMount: nasMount, scanRoot: nasSibling, mountinfoPath }),
      /不在要求挂载点/
    );

    // Invalid: directory exists on disk, NOT empty, but NOT in mountinfo!
    fs.writeFileSync(path.join(nasSibling, "dummy.txt"), "non-empty");
    assert.throws(
      () => verifyRequiredMount({ requireMount: nasSibling, scanRoot: nasSibling, mountinfoPath }),
      /未出现在活动挂载表/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("E2E real gdu scan -> EFU -> EfuCore parser -> search (CSV specials, hidden, .gitignore, excludes, symlinks, UNC prefix)", { skip: !GDU_BIN }, () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-e2e-"));
  const rootDir = path.join(workDir, "projects");
  const outsideDir = path.join(workDir, "outside");
  const outDir = path.join(workDir, "indexes");
  const outFile = path.join(outDir, "projects.efu");

  try {
    fs.mkdirSync(path.join(rootDir, "中文 目录"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, ".hidden_dir"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, ".snapshot", "locked"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "@eaDir"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "sub", "cache"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "sub", ".snapshot"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "my.snapshot_keep"), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    // Regular files with tricky names & sizes
    fs.writeFileSync(path.join(rootDir, "empty.txt"), "");
    fs.writeFileSync(path.join(rootDir, ".hidden_file"), "hidden");
    fs.writeFileSync(path.join(rootDir, ".hidden_dir", "inside_hidden.txt"), "in-hidden");
    fs.writeFileSync(path.join(rootDir, ".gitignore"), "*.ignored\n");
    fs.writeFileSync(path.join(rootDir, "must_keep.ignored"), "12345");
    fs.writeFileSync(path.join(rootDir, "中文 目录", '报告, "2026" 终稿.pdf'), "0123456789abcdef");
    fs.writeFileSync(path.join(rootDir, "line1\nline2.txt"), "nl");
    fs.writeFileSync(path.join(rootDir, "my.snapshot_keep", "stay.txt"), "ok");

    // Excluded subtrees (including an unreadable subdir inside .snapshot to verify pruning!)
    fs.writeFileSync(path.join(rootDir, ".snapshot", "locked", "snap.txt"), "snap");
    fs.chmodSync(path.join(rootDir, ".snapshot", "locked"), 0o000);
    fs.writeFileSync(path.join(rootDir, "@eaDir", "thumb.jpg"), "ea");
    fs.writeFileSync(path.join(rootDir, "sub", ".snapshot", "nested_snap.txt"), "ns");
    fs.writeFileSync(path.join(rootDir, "sub", "cache", "tmp.bin"), "cache");

    // Symlinks (must NOT be followed!)
    fs.writeFileSync(path.join(outsideDir, "secret_outside.txt"), "outside-content");
    fs.symlinkSync(outsideDir, path.join(rootDir, "link_to_outside_dir"));
    fs.symlinkSync(path.join(outsideDir, "secret_outside.txt"), path.join(rootDir, "link_to_file"));
    fs.symlinkSync(path.join(workDir, "missing_target"), path.join(rootDir, "broken_symlink"));

    // Run real CLI with argument array
    const cliRes = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        "--root",
        rootDir,
        "--output",
        outFile,
        "--exclude",
        ".snapshot",
        "--exclude",
        "@eaDir",
        "--exclude",
        "sub/cache",
        "--export-prefix",
        "\\\\nas\\projects",
        "--gdu-bin",
        GDU_BIN,
      ],
      { encoding: "utf8" }
    );

    assert.equal(cliRes.status, 0, `CLI failed: ${cliRes.stderr}`);
    assert.match(cliRes.stdout, /scanner=gdu v/);
    assert.equal(listTempFiles(outDir).length, 0);

    // Parse generated EFU with EfuCore
    const efuText = fs.readFileSync(outFile, "utf8");
    const parsed = EfuCore.parseEfu(efuText);

    assert.deepEqual(parsed.header, ["Filename", "Size", "Date Modified"]);
    assert.equal(parsed.columns.hasSize, true);
    assert.equal(parsed.columns.hasModified, true);
    assert.equal(parsed.columns.hasCreated, false);

    const byPath = new Map(parsed.entries.map((e) => [e.path, e]));

    // Verify UNC prefix + CSV escaping + exact apparent size + valid mtime
    const pdf = byPath.get('\\\\nas\\projects\\中文 目录\\报告, "2026" 终稿.pdf');
    assert.ok(pdf, "Chinese/comma/quote PDF should be indexed");
    assert.equal(pdf.fileName, '报告, "2026" 终稿.pdf');
    assert.equal(pdf.sizeBig, 16n);
    assert.ok(pdf.modifiedBig !== null && EfuCore.filetimeToDate(pdf.modifiedBig) !== null);

    // Verify empty file is 0 B (not missing)
    const empty = byPath.get("\\\\nas\\projects\\empty.txt");
    assert.ok(empty);
    assert.equal(empty.sizeBig, 0n);
    assert.equal(EfuCore.formatSize(empty), "0 B");

    // Verify embedded newline filename survived roundtrip
    const nl = byPath.get("\\\\nas\\projects\\line1\nline2.txt");
    assert.ok(nl);
    assert.equal(nl.fileName, "line1\nline2.txt");
    assert.equal(nl.sizeBig, 2n);

    // Verify hidden files and .gitignore-matched files are INCLUDED
    assert.ok(byPath.has("\\\\nas\\projects\\.hidden_file"));
    assert.ok(byPath.has("\\\\nas\\projects\\.hidden_dir\\inside_hidden.txt"));
    assert.ok(byPath.has("\\\\nas\\projects\\must_keep.ignored"));

    // Verify similar name was NOT falsely excluded
    assert.ok(byPath.has("\\\\nas\\projects\\my.snapshot_keep\\stay.txt"));

    // Verify excluded directories were PRUNED
    for (const p of byPath.keys()) {
      assert.ok(!p.includes("\\.snapshot\\"), `Excluded .snapshot leaked: ${p}`);
      assert.ok(!p.includes("\\@eaDir\\"), `Excluded @eaDir leaked: ${p}`);
      assert.ok(!p.includes("\\sub\\cache\\"), `Excluded sub/cache leaked: ${p}`);
    }

    // Verify symlinks were NOT followed into outsideDir and do NOT fabricate file sizes
    for (const p of byPath.keys()) {
      assert.ok(!p.includes("secret_outside.txt"), `Symlink target directory was followed: ${p}`);
    }
    const dirLink = byPath.get("\\\\nas\\projects\\link_to_outside_dir");
    assert.ok(dirLink);
    assert.equal(dirLink.sizeBig, null);
    assert.equal(EfuCore.formatSize(dirLink), "—");

    // Verify EfuCore search finds the target file
    const found = EfuCore.filterAndSortEntries(parsed.entries, { query: "报告 2026" });
    assert.equal(found.filtered.length, 1);
    assert.equal(found.filtered[0].fileName, '报告, "2026" 终稿.pdf');
  } finally {
    try {
      fs.chmodSync(path.join(rootDir, ".snapshot", "locked"), 0o755);
    } catch {
      // ignore
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("legitimate empty directory produces header-only EFU parsing to 0 entries", { skip: !GDU_BIN }, () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-empty-dir-"));
  const emptyRoot = path.join(workDir, "empty");
  const outFile = path.join(workDir, "empty.efu");

  try {
    fs.mkdirSync(emptyRoot);
    const result = runScanToEfu({ root: emptyRoot, output: outFile, gduBin: GDU_BIN });
    assert.equal(result.entryCount, 0);

    const content = fs.readFileSync(outFile, "utf8");
    assert.equal(content, "Filename,Size,Date Modified\r\n");

    const parsed = EfuCore.parseEfu(content);
    assert.equal(parsed.entries.length, 0);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("publish failures leave existing EFU byte-for-byte unchanged and clean temp files", { skip: !GDU_BIN }, () => {
  assert.notEqual(process.getuid(), 0, "Permission failure tests must NOT run as root");

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "efu-fail-"));
  const rootDir = path.join(workDir, "data");
  const outDir = path.join(workDir, "indexes");
  const outFile = path.join(outDir, "projects.efu");
  const fakeBinDir = path.join(workDir, "fake-bin");

  try {
    fs.mkdirSync(path.join(rootDir, "readable"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "unreadable"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "no_exec"), { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(fakeBinDir, { recursive: true });

    fs.writeFileSync(path.join(rootDir, "readable", "ok.txt"), "hello");
    fs.writeFileSync(path.join(rootDir, "unreadable", "secret.txt"), "secret");
    fs.writeFileSync(path.join(rootDir, "no_exec", "nostat.txt"), "nostat");

    // Seed an initial valid snapshot and record its SHA-256
    const baseline = "Filename,Size,Date Modified\r\n/mnt/nas/projects/baseline.txt,42,134000000000000000\r\n";
    fs.writeFileSync(outFile, baseline, "utf8");
    const baselineHash = sha256File(outFile);

    const assertPreserved = (label) => {
      assert.equal(sha256File(outFile), baselineHash, `${label}: existing EFU must remain byte-for-byte identical`);
      assert.equal(listTempFiles(outDir).length, 0, `${label}: temp files must be cleaned up`);
    };

    // 1. Unreadable subdirectory (chmod 000 -> gdu read_error + log permission denied)
    fs.chmodSync(path.join(rootDir, "unreadable"), 0o000);
    assert.throws(
      () => runScanToEfu({ root: rootDir, output: outFile, gduBin: GDU_BIN }),
      /permission denied|read_error/i
    );
    assertPreserved("unreadable subdir");
    fs.chmodSync(path.join(rootDir, "unreadable"), 0o755);

    // 2. Directory without execute bit (chmod 600 -> lstat error inside directory)
    fs.chmodSync(path.join(rootDir, "no_exec"), 0o600);
    assert.throws(
      () => runScanToEfu({ root: rootDir, output: outFile, gduBin: GDU_BIN }),
      /permission denied|read_error/i
    );
    assertPreserved("lstat error dir");
    fs.chmodSync(path.join(rootDir, "no_exec"), 0o755);

    // 3. Scanner exits non-zero
    const failScript = path.join(fakeBinDir, "gdu-fail");
    fs.writeFileSync(failScript, "#!/bin/sh\necho 'simulated I/O failure' >&2\nexit 2\n", { mode: 0o755 });
    assert.throws(
      () => runScanToEfu({ root: rootDir, output: outFile, gduBin: failScript }),
      /退出异常/
    );
    assertPreserved("scanner non-zero exit");

    // 4. Scanner exits 0 but outputs truncated JSON
    const truncScript = path.join(fakeBinDir, "gdu-trunc");
    fs.writeFileSync(
      truncScript,
      `#!/bin/sh
OUT=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; OUT="$1"; fi
  shift
done
printf '[1,2,{"progname":"gdu","progver":"v5.39.0"},[{"name":"%s",' "${rootDir}" > "$OUT"
exit 0
`,
      { mode: 0o755 }
    );
    assert.throws(
      () => runScanToEfu({ root: rootDir, output: outFile, gduBin: truncScript }),
      /解析失败|截断/
    );
    assertPreserved("truncated JSON");

    // 5. Mount check failure BEFORE scan
    const badMountinfo = path.join(workDir, "empty-mountinfo");
    fs.writeFileSync(badMountinfo, "22 1 8:1 / / rw - ext4 /dev/sda1 rw\n", "utf8");
    assert.throws(
      () =>
        runScanToEfu({
          root: rootDir,
          output: outFile,
          requireMount: rootDir,
          mountinfoPath: badMountinfo,
          gduBin: GDU_BIN,
        }),
      /挂载点检查失败/
    );
    assertPreserved("pre-scan mount check");

    // 6. Mount check failure RIGHT BEFORE publish (fault injection: mount disappears mid-scan)
    const dynamicMountinfo = path.join(workDir, "dynamic-mountinfo");
    const realRoot = fs.realpathSync(rootDir);
    fs.writeFileSync(
      dynamicMountinfo,
      `22 1 8:1 / / rw - ext4 /dev/sda1 rw\n99 22 0:45 / ${realRoot} ro - cifs //nas/p ro\n`,
      "utf8"
    );
    assert.throws(
      () =>
        runScanToEfu({
          root: rootDir,
          output: outFile,
          requireMount: rootDir,
          mountinfoPath: dynamicMountinfo,
          gduBin: GDU_BIN,
          transformHook: () => {
            // Simulate unmount right before atomic publish
            fs.writeFileSync(dynamicMountinfo, "22 1 8:1 / / rw - ext4 /dev/sda1 rw\n", "utf8");
          },
        }),
      /挂载点检查失败/
    );
    assertPreserved("pre-publish mount loss");

    // 7. Conversion / transform failure
    assert.throws(
      () =>
        runScanToEfu({
          root: rootDir,
          output: outFile,
          gduBin: GDU_BIN,
          transformHook: () => {
            throw new Error("simulated conversion failure");
          },
        }),
      /simulated conversion failure/
    );
    assertPreserved("conversion failure");
  } finally {
    for (const d of ["unreadable", "no_exec"]) {
      try {
        fs.chmodSync(path.join(rootDir, d), 0o755);
      } catch {
        // ignore
      }
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
