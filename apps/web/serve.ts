// Copies the deployment record and sample receipts next to the pages, bundles
// the app's wallet code, then serves the folder. The output is plain static
// files: host it anywhere.
//
//   pnpm web            build and serve on http://127.0.0.1:8080  (site at /, app at /app/, docs at /docs/)
//   pnpm web --build    build only
//   HOST=0.0.0.0 PORT=80 pnpm web    serve publicly
//   BARREL_NETWORK=testnet pnpm web  pages for the testnet (development) deployment

import { copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "./build.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..", "..");
// The pages are built for mainnet; BARREL_NETWORK=testnet builds them for the development deployment.
const net = process.env.BARREL_NETWORK ?? "mainnet";
const d = JSON.parse(readFileSync(join(root, "deployments", `${net}.json`), "utf8"));
const page = {
  network: d.network,
  rpc: d.rpc,
  contract: d.contract,
  usdc: d.usdc,
  owner: d.owner,
  operator: d.operator,
  wasm_sha256: d.wasm_sha256,
  deployed_at: d.deployed_at,
  config: d.config,
  grades: d.grades,
  series: d.series,
  sample_receipts: d.sample_receipts,
};
writeFileSync(join(here, "deployment.json"), `${JSON.stringify(page, null, 2)}\n`);
// A receipt settled on this deployment, or the captured one from the repo's fixtures before any exists.
copyFileSync(join(root, d.sample_receipts[0]?.file ?? "fixtures/receipt.json"), join(here, "sample-receipt.json"));
copyFileSync(join(root, "fixtures", "gateway-kind.json"), join(here, "gateway-receipt.json"));
await bundle();
console.log(`page data and app bundle written for ${d.contract}`);

if (!process.argv.includes("--build")) {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  const port = Number(process.env.PORT ?? 8080);
  createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // directories need a trailing slash so relative asset paths resolve
    if (path === "/app" || path === "/docs") {
      res.writeHead(301, { location: `${path}/` }).end();
      return;
    }
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(here, path));
    const type = types[extname(file)];
    const inside = file.startsWith(here.endsWith(sep) ? here : here + sep);
    const hidden = /[\\/](node_modules|src)[\\/]/.test(file.slice(here.length));
    if (!inside || hidden || !type || file.endsWith(".ts")) {
      res.writeHead(404).end();
      return;
    }
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
      const cache = file.includes(`${sep}assets${sep}fonts${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
      res.writeHead(200, { "content-type": type, "cache-control": cache }).end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  }).listen(port, process.env.HOST ?? "127.0.0.1", () => console.log(`http://${process.env.HOST ?? "127.0.0.1"}:${port}   (app: /app/, docs: /docs/)`));
}
