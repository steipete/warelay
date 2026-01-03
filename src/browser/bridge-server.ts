import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import type { ResolvedBrowserConfig } from "./config.js";
import { registerBrowserRoutes } from "./routes/index.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
} from "./server-context.js";

export type BrowserBridge = {
  server: Server;
  port: number;
  baseUrl: string;
  state: BrowserServerState;
};

export async function startBrowserBridgeServer(params: {
  resolved: ResolvedBrowserConfig;
  host?: string;
  port?: number;
}): Promise<BrowserBridge> {
  const host = params.host ?? "127.0.0.1";
  const port = params.port ?? 0;

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const state: BrowserServerState = {
    server: null as unknown as Server,
    port,
    cdpPort: params.resolved.cdpPort,
    running: null,
    resolved: params.resolved,
  };

  const ctx = createBrowserRouteContext({
    getState: () => state,
    setRunning: (running) => {
      state.running = running;
    },
  });
  registerBrowserRoutes(app, ctx);

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.once("error", reject);
  });

  const address = server.address() as AddressInfo | null;
  const resolvedPort = address?.port ?? port;
  state.server = server;
  state.port = resolvedPort;
  state.resolved.controlHost = host;
  state.resolved.controlPort = resolvedPort;
  state.resolved.controlUrl = `http://${host}:${resolvedPort}`;

  const baseUrl = state.resolved.controlUrl;
  return { server, port: resolvedPort, baseUrl, state };
}

export async function stopBrowserBridgeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
