// Bundles the app's wallet and tank code (src/near.ts) for the browser.
//
//   pnpm --filter @barrel/web build      writes assets/js/near.bundle.js
//
// serve.ts runs this on start, so `pnpm web` always serves a fresh bundle.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));

export async function bundle(): Promise<void> {
  await build({
    entryPoints: { "js/near.bundle": join(here, "src", "near.ts") },
    outdir: join(here, "assets"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
    alias: { util: join(here, "src", "shims", "util.ts") },
    inject: [join(here, "src", "shims", "buffer.ts")],
    logLevel: "warning",
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await bundle();
  console.log("assets/js/near.bundle.js written");
}
