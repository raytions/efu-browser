#!/usr/bin/env node
import { runScanToEfu } from "./efu-scan-lib.mjs";

const USAGE = `用法:
  node scripts/efu-scan.mjs --root <目录> --output <输出.efu> [选项]

选项:
  --root <dir>             必需。要扫描的根目录路径。
  --output <file>          必需。输出的 EFU 文件路径（将原子替换旧文件）。
  --exclude <pattern>      可重复。排除目录并剪枝跳过整棵子树：
                           - 不含 "/"：按目录名匹配任意层级（例如 .snapshot、@eaDir）
                           - 包含 "/"：按相对 --root 的目录路径匹配（例如 cache/tmp）
  --require-mount <path>   可选。要求指定挂载点真实存在于 /proc/self/mountinfo，
                           且 --root 等于或位于该挂载点之下（扫描前与发布前均校验）。
  --export-prefix <prefix> 可选。仅重写导出 EFU 中的路径前缀（例如 \\\\nas\\projects），
                           保留相对层级，不改变扫描位置。
  --gdu-bin <path>         可选。指定 gdu 可执行文件路径（默认读取 EFU_GDU_BIN 或 PATH 中的 gdu）。
  -h, --help               显示此帮助信息。

示例:
  node scripts/efu-scan.mjs \\
    --root /mnt/nas/projects \\
    --output /srv/efu-browser/indexes/projects.efu \\
    --exclude .snapshot \\
    --exclude @eaDir \\
    --require-mount /mnt/nas \\
    --export-prefix '\\\\nas\\projects'
`;

function parseArgs(argv) {
  const options = {
    root: null,
    output: null,
    excludes: [],
    requireMount: null,
    exportPrefix: null,
    gduBin: process.env.EFU_GDU_BIN || "gdu",
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }

    const nextValue = () => {
      if (i + 1 >= argv.length) {
        throw new Error(`参数 ${arg} 缺少取值`);
      }
      i += 1;
      return argv[i];
    };

    if (arg === "--root") {
      options.root = nextValue();
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--output") {
      options.output = nextValue();
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg === "--exclude") {
      options.excludes.push(nextValue());
    } else if (arg.startsWith("--exclude=")) {
      options.excludes.push(arg.slice("--exclude=".length));
    } else if (arg === "--require-mount") {
      options.requireMount = nextValue();
    } else if (arg.startsWith("--require-mount=")) {
      options.requireMount = arg.slice("--require-mount=".length);
    } else if (arg === "--export-prefix") {
      options.exportPrefix = nextValue();
    } else if (arg.startsWith("--export-prefix=")) {
      options.exportPrefix = arg.slice("--export-prefix=".length);
    } else if (arg === "--gdu-bin") {
      options.gduBin = nextValue();
    } else if (arg.startsWith("--gdu-bin=")) {
      options.gduBin = arg.slice("--gdu-bin=".length);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[efu-scan] 参数错误：${error.message}`);
    console.error("使用 --help 查看用法。");
    process.exit(2);
  }

  if (options.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  try {
    const result = runScanToEfu(options);
    console.log(
      `[efu-scan] 成功 | scanner=${result.scanner} ${result.scannerVersion} | entries=${result.entryCount} | duration=${result.durationMs}ms | output=${result.output}`
    );
  } catch (error) {
    console.error(`[efu-scan] 失败：${error.message}`);
    process.exit(1);
  }
}

main();
