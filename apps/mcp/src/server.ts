// MCP server (stdio) that gives an agent one Barrel tank.
//
// The agent gets three tools: ask, balance and verify. It holds only the
// tank's spend key, so the worst it can do is spend the tank on answers that
// carry a valid model signature. It cannot transfer, withdraw or refund.
//
// Claude Code:
//   claude mcp add barrel -e BARREL_TANK=1 -- node /path/to/barrel/apps/mcp/bin/barrel-mcp.mjs
//
// Environment: BARREL_TANK (required), BARREL_TANK_KEY (the spend key from promptbarrel.com/app)
// or BARREL_TANK_KEY_FILE (default: .barrel/tanks/<contract>/<tank>.json),
// BARREL_CONTRACT (default: deployments/<BARREL_NETWORK>.json), BARREL_NETWORK (default mainnet), BARREL_PUMP_URL.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Barrel, Chain, STATE_DIR, TankClient, ProofError, network, readDeployment, stablecoinName } from "@barrel/sdk";
import { checkReceipt, RECEIPT_LIMITS, type Receipt } from "@barrel/verifier";

const log = (...args: unknown[]) => console.error("[barrel-mcp]", ...args);

const deploymentContract = (): string | undefined => readDeployment()?.contract;
const chain = new Chain(network());
const coin = stablecoinName();
let ready: Promise<{ barrel: Barrel; client?: TankClient; tankId?: number }> | undefined;

function setup() {
  ready ??= (async () => {
    const contract = process.env.BARREL_CONTRACT ?? deploymentContract();
    if (!contract) throw new Error("set BARREL_CONTRACT");
    const config = await chain.view<{ usdc: string }>(contract, "get_config");
    const barrel = new Barrel(chain, contract, config.usdc);
    const tankText = process.env.BARREL_TANK;
    if (!tankText) return { barrel };
    const tankId = Number(tankText);
    // The key comes from the app ("Connect an agent") as BARREL_TANK_KEY, or from a key file.
    const keyFile = process.env.BARREL_TANK_KEY_FILE ?? join(STATE_DIR, "tanks", contract, `${tankId}.json`);
    const secret = process.env.BARREL_TANK_KEY ?? (JSON.parse(readFileSync(keyFile, "utf8")).secret_key as string);
    const client = new TankClient({ barrel, tankId, tankSecretKey: secret, pumpUrl: process.env.BARREL_PUMP_URL });
    return { barrel, client, tankId };
  })();
  return ready;
}

const tools = [
  {
    name: "barrel_ask",
    description:
      "Ask the tank's model a question. The answer is paid for from the tank only if it carries a valid signature from the named model's TEE, which this tool checks before acknowledging. Returns the answer, the units paid and the settlement transaction.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The prompt to send." },
        system: { type: "string", description: "Optional system message." },
        max_tokens: { type: "integer", minimum: 1, maximum: 4096, description: "Upper bound on output tokens (default 800)." },
      },
      required: ["question"],
    },
  },
  {
    name: "barrel_balance",
    description: "Units left in the tank, the model it pays for, and the price. For a job tank, also what the leftover pays you if the client accepts the work.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "barrel_verify",
    description:
      "Check a Barrel receipt: hashes, signature kind, the model named in the signed text, and whether the contract has the signing key registered. Accepts the receipt JSON or a file path.",
    inputSchema: {
      type: "object",
      properties: {
        receipt: { description: "Receipt object, JSON string, or path to a receipt file." },
      },
      required: ["receipt"],
    },
  },
];

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

async function callTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  const { barrel, client, tankId } = await setup();
  switch (name) {
    case "barrel_ask": {
      if (!client) return text("No tank configured: set BARREL_TANK.", true);
      const messages = [
        ...(args.system ? [{ role: "system", content: String(args.system) }] : []),
        { role: "user", content: String(args.question) },
      ];
      try {
        const r = await client.chat({ messages, max_tokens: Number(args.max_tokens ?? 800), reasoning_effort: "low" });
        // Keep the proof: the receipt lets the client (or anyone) re-check what was paid for.
        const dir = join(STATE_DIR, "receipts");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${barrel.contractId}-${tankId}-${r.seq}.json`);
        writeFileSync(file, `${JSON.stringify(r.receipt, null, 2)}\n`);
        return text(
          [
            r.content.trim() || "(no visible answer: the token limit was spent on reasoning)",
            "",
            `-- paid ${r.units} units (${r.usage.prompt_tokens} prompt + ${r.usage.completion_tokens} completion tokens) after ${r.checks.length} checks passed`,
            `-- model ${r.receipt.model_id}, TEE key ${r.receipt.signing_address.slice(0, 16)}…`,
            r.settleTx ? `-- settled: ${chain.net.explorerTx}${r.settleTx}` : "-- acknowledged; the Pump settles in batches",
            `-- receipt saved: ${file}`,
          ].join("\n"),
        );
      } catch (e) {
        if (e instanceof ProofError) {
          const failed = e.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
          return text(`Refused to pay: ${e.message}\n${failed.join("\n")}`, true);
        }
        return text(`Request failed: ${e instanceof Error ? e.message : e}`, true);
      }
    }
    case "barrel_balance": {
      if (!client || tankId === undefined) return text("No tank configured: set BARREL_TANK.", true);
      const tank = (await barrel.tank(tankId))!;
      const series = (await barrel.series(tank.series_id))!;
      const grade = (await barrel.grade(series.grade_id))!;
      const lines = [
        `tank ${tankId}: ${tank.balance} units left, ${tank.spent} spent over ${tank.next_seq} answers${tank.closed ? " (closed)" : ""}`,
        `model ${grade.model_id}; 1 unit = 1 output token, input tokens count at ${grade.input_weight_bps / 100}%`,
        `price ${Number(series.price_per_barrel) / 1e6} ${coin} per 1,000,000 units; series ends ${new Date(series.window_end * 1000).toISOString()}`,
      ];
      if (tank.agent) {
        // Rounded down per payout, so this can be one base unit high.
        const worth = (Number((BigInt(tank.balance) * BigInt(series.price_per_barrel)) / 1_000_000n) / 1e6).toFixed(6);
        lines.push(
          tank.accepted
            ? `job tank: accepted. The leftover, about ${worth} ${coin}, pays out to ${tank.agent} from ${new Date(tank.unlock_at! * 1000).toISOString()}.`
            : `job tank for ${tank.agent}: if the client accepts your work, the leftover pays you about ${worth} ${coin}. Every answer you ask for comes out of it.`,
        );
      } else if (tank.unlock_at !== null && !tank.closed) {
        lines.push(`the owner is taking this tank back; it is no longer served`);
      }
      return text(lines.join("\n"));
    }
    case "barrel_verify": {
      let input = args.receipt;
      if (typeof input === "string") input = existsSync(input) ? JSON.parse(readFileSync(input, "utf8")) : JSON.parse(input);
      const receipt = input as Receipt;
      const local = checkReceipt(receipt);
      const view = await barrel.verifyReceipt(receipt);
      const lines = local.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}`);
      lines.push(`${view.key_registered ? "✓" : "✗"} signing key registered for grade ${receipt.grade_id} on ${barrel.contractId}`);
      const valid = local.valid && view.valid;
      lines.push("", valid ? "VALID" : local.valid ? `REJECTED: ${view.reason}` : local.verdict, "", ...RECEIPT_LIMITS.map((l) => `- ${l}`));
      return text(lines.join("\n"), !valid);
    }
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  }
}

function send(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  const reply = (result: unknown) => msg.id !== undefined && send({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => msg.id !== undefined && send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  try {
    switch (msg.method) {
      case "initialize":
        reply({
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "barrel", version: "0.1.0" },
          instructions:
            "barrel_ask pays for an answer only when the model's TEE signature checks out. Use barrel_balance before long tasks. On a job tank the leftover is your pay when the client accepts the work, so ask only what the work needs.",
        });
        break;
      case "ping":
        reply({});
        break;
      case "tools/list":
        reply({ tools });
        break;
      case "tools/call":
        reply(await callTool(msg.params?.name, msg.params?.arguments ?? {}));
        break;
      default:
        if (msg.id !== undefined && !String(msg.method).startsWith("notifications/")) fail(-32601, `method not found: ${msg.method}`);
    }
  } catch (e: any) {
    log(e);
    fail(typeof e?.code === "number" ? e.code : -32603, e instanceof Error ? e.message : String(e));
  }
});
