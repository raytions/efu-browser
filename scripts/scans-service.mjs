#!/usr/bin/env node
import {
  createScansHttpServer,
  createScansManager,
  parseBooleanEnv,
} from "./scans-service-lib.mjs";

function main() {
  const mode = (process.env.SCANS_MODE || "demo").trim().toLowerCase();
  if (mode !== "real") {
    console.error(
      `[scans-service] 当前 SCANS_MODE=${mode}（非 real），受控扫描 API 服务未启用。请设置 SCANS_MODE=real 启动。`
    );
    process.exit(0);
  }

  const host = (process.env.SCANS_HOST || "127.0.0.1").trim();
  const port = Number.parseInt(process.env.SCANS_PORT || "3001", 10);
  const apiBase = (process.env.SCANS_API_BASE || "/api/scans").trim();
  const allowTrigger = parseBooleanEnv(process.env.SCANS_ALLOW_TRIGGER, false);
  const tasksFile = (process.env.SCANS_TASKS_FILE || "/config/scans.json").trim();
  const indexDir = (process.env.SCANS_INDEX_DIR || "/app/indexes").trim();
  const stateFile = (process.env.SCANS_STATE_FILE || "").trim() || null;
  const gduBin = (process.env.EFU_GDU_BIN || "gdu").trim();
  const indexUrlPrefix = (process.env.SCANS_INDEX_URL_PREFIX || "/indexes/").trim();

  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.error(`[scans-service] 无效的监听端口 SCANS_PORT=${process.env.SCANS_PORT}`);
    process.exit(2);
  }

  let manager;
  try {
    manager = createScansManager({
      tasksFile,
      indexDir,
      stateFile,
      allowTrigger,
      gduBin,
      indexUrlPrefix,
    });
  } catch (error) {
    console.error(`[scans-service] 初始化失败：${error.message}`);
    process.exit(1);
  }

  const server = createScansHttpServer(manager, { apiBase });

  const shutdown = () => {
    manager.shutdown();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(port, host, () => {
    console.log(
      `[scans-service] 已启动 | listen=http://${host}:${port}${apiBase} | tasks=${manager.listPublicTasks().length} | allowTrigger=${manager.allowTrigger}`
    );
  });
}

main();
