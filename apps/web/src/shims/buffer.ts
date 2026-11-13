// Node's Buffer, for wallet code that expects it in the browser (HOT Wallet's
// SDK). build.ts injects this, so every bare `Buffer` in the bundle uses it.
export { Buffer } from "buffer";
