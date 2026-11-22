import { createServer } from "node:http";
import { CardCache } from "./cards/cache.js";
import { connectCardRepository } from "./cards/repo.js";
import { config } from "./config.js";
import { AuthService } from "./auth/AuthService.js";
import { createAuthRouter } from "./http/auth.js";
import { createAdminRouter } from "./http/admin.js";
import { createHttpApp } from "./http/routes.js";
import { RoomManager } from "./rooms/RoomManager.js";
import { attachWebSocketServer } from "./ws/server.js";

async function start(): Promise<void> {
  const repository = await connectCardRepository(config.mongoUri, config.mongoDb);
  const cache = new CardCache(repository);
  await cache.refresh();

  const rooms = new RoomManager(cache);
  const auth = new AuthService((username) => repository.adminUsers.findOne({ username }));
  const authRouter = createAuthRouter(auth);
  const admin = createAdminRouter(repository, cache, config.adminToken);
  const app = createHttpApp(rooms, cache, config.allowedOrigins, admin, auth, authRouter);
  const server = createServer(app);
  const ws = attachWebSocketServer(server, rooms, auth, config.allowedOrigins);
  const refreshTimer = setInterval(() => {
    void cache.refresh().catch(() => console.warn("Card cache refresh failed."));
  }, config.cardCacheTtlMs);
  refreshTimer.unref();

  server.listen(config.port, () => console.log(`Family Gaming Hub API listening on port ${config.port}`));

  const shutdown = () => {
    clearInterval(refreshTimer);
    void (async () => {
      await ws.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await repository.close();
    })().catch(() => {
      console.error("Graceful shutdown failed.");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

start().catch(() => {
  console.error("Failed to start Family Gaming Hub API.");
  process.exitCode = 1;
});
