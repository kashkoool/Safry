// Scans the API container log for personal data and secrets that would break a retention policy, and sizes it.
//   node logscan.mjs --run a [--since 6h]
import { parseArgs, loadRunEnv, saveJson, docker } from "./common.mjs";

const args = parseArgs();
const run = loadRunEnv(args.run ?? "a");
const text = docker("logs", ...(args.since ? ["--since", String(args.since)] : []), run.apiContainer);
const lines = text.split("\n").filter(Boolean);
const patterns = {
  emailAddress: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  jwt: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  emailedLinkOrToken: /(?:link=|#token=|token=)[A-Za-z0-9_\-:/.#=?]{10,}/,
  longRandomToken43: /\b[A-Za-z0-9_-]{43}\b/,
  authorizationHeader: /authorization/i,
  cookie: /set-cookie|refresh_token/i
};
const byContext = {}, hits = {}, examples = {};
let bytes = 0;
for (const line of lines) {
  bytes += Buffer.byteLength(line) + 1;
  let ctx = "?", message = line;
  try { const j = JSON.parse(line); ctx = j.context ?? "?"; message = typeof j.message === "string" ? j.message : JSON.stringify(j.message); } catch { /* raw line */ }
  const b = (byContext[ctx] ??= { lines: 0, bytes: 0 });
  b.lines += 1; b.bytes += Buffer.byteLength(line) + 1;
  for (const [name, re] of Object.entries(patterns)) {
    if (!re.test(message)) continue;
    const key = `${name} in ${ctx}`;
    hits[key] = (hits[key] ?? 0) + 1;
    if ((examples[key] ??= []).length < 2) examples[key].push(message.replace(/(eyJ[A-Za-z0-9_-]{6})[A-Za-z0-9_.-]+/g, "$1...").replace(/(token=)[A-Za-z0-9_-]+/g, "$1<redacted>").slice(0, 220));
  }
}
const out = { run: run.run, lines: lines.length, bytes, byContext, hits, examples };
saveJson(`logscan-${run.run}.json`, out);
console.log(JSON.stringify({ lines: lines.length, bytes, hits, byContext }, null, 1));
