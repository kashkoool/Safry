// LOCAL ONLY. Receives Alertmanager webhooks and appends one line per alert to /out/alerts.log. No network calls out.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      for (const alert of payload.alerts ?? [])
        appendFileSync("/out/alerts.log", `${new Date().toISOString()} ${alert.status} ${alert.labels?.alertname} severity=${alert.labels?.severity}\n`);
    } catch {
      appendFileSync("/out/alerts.log", `${new Date().toISOString()} unreadable payload\n`);
    }
    response.end("ok");
  });
}).listen(9099);
