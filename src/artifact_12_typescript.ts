import * as http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(8080, () => {
  console.log("[TELEMETRY] Healthcheck listening on :8080/healthz");
});