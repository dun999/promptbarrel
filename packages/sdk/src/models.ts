// The models Barrel offers: every chat model that NEAR AI Cloud serves from
// its own attested TEEs. Each becomes a grade, and a grade is only added when
// the model's attestation passes on the day of deployment.
//
// A grade's input weight is the model's input price over its output price,
// so one unit costs the same whether it was read or written. The series
// price is the output price per million tokens plus a 20% operator margin.
// Prices are NEAR AI Cloud's list prices in USD per million tokens
// (cloud-api.near.ai/v1/model/list, 14 Nov 2026).

export interface ModelSpec {
  /** Grade id on-chain. */
  grade: string;
  /** Canonical model id, exactly as the model TEE writes it in the text it signs. */
  model: string;
  label: string;
  inputUsd: number;
  outputUsd: number;
  /** The cheapest model. Tests and sample answers use it. */
  cheapest?: boolean;
}

export const MODELS: ModelSpec[] = [
  { grade: "glm-5.3-flash", model: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", inputUsd: 0.08, outputUsd: 0.5, cheapest: true },
  { grade: "qwen3-vl-30b", model: "Qwen/Qwen3-VL-30B-A3B-Instruct", label: "Qwen3 VL 30B", inputUsd: 0.15, outputUsd: 0.55 },
  { grade: "qwen3.6-35b", model: "Qwen/Qwen3.6-35B-A3B-FP8", label: "Qwen3.6 35B", inputUsd: 0.17, outputUsd: 1.1 },
  { grade: "deepseek-v4.1-flash", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", label: "DeepSeek V4.1 Flash", inputUsd: 0.3, outputUsd: 1.2 },
  { grade: "qwen3.8-27b", model: "Qwen/Qwen3.8-27B", label: "Qwen3.8 27B", inputUsd: 0.04, outputUsd: 1.35 },
];

export const CHEAPEST_MODEL = MODELS.find((m) => m.cheapest)!;

/** Units charged per prompt token, in basis points of one output token (rounded up). */
export const inputWeightBps = (m: ModelSpec) => {
  const micro = (usd: number) => BigInt(Math.round(usd * 1_000_000));
  return Number((micro(m.inputUsd) * 10_000n + micro(m.outputUsd) - 1n) / micro(m.outputUsd));
};

/** USDC base units for one Barrel (1,000,000 units): the output price plus the margin. */
export const pricePerBarrel = (m: ModelSpec, marginBps = 2000) => BigInt(Math.round(m.outputUsd * 1_000_000 * (1 + marginBps / 10_000)));
