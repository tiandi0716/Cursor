import { startAppServer } from "./server.ts";

const isElectron = Boolean(process.versions.electron);
if (!isElectron) {
  const running = await startAppServer();
  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
