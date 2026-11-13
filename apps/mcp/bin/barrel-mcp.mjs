#!/usr/bin/env node
// Launcher for MCP clients: nothing but protocol messages on stdout.
//   claude mcp add barrel -e BARREL_TANK=1 -- node /absolute/path/to/apps/mcp/bin/barrel-mcp.mjs
import { register } from "tsx/esm/api";

register();
await import("../src/server.ts");
