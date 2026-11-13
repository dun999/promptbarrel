// The one part of Node's `util` a wallet dependency (is-my-json-valid, via
// @near-js/accounts) calls in the browser: printf-style `format`.
export function format(f: unknown, ...args: unknown[]): string {
  if (typeof f !== "string") return [f, ...args].map(String).join(" ");
  let i = 0;
  const out = f.replace(/%[sdijfo%]/g, (m) => {
    if (m === "%%") return "%";
    if (i >= args.length) return m;
    const v = args[i++];
    if (m === "%d" || m === "%i") return String(Number.parseInt(String(v), 10));
    if (m === "%f") return String(Number.parseFloat(String(v)));
    if (m === "%j" || m === "%o") return JSON.stringify(v);
    return String(v);
  });
  return [out, ...args.slice(i).map(String)].join(" ");
}
export const inspect = (v: unknown) => JSON.stringify(v);
export default { format, inspect };
