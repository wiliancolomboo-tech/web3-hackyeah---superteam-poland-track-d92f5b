const http = require("http");

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "healthy",
      service: "vistula-automation-daemon",
      uptime: process.uptime(),
      timestamp: Date.now()
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(8080, () => {
  console.log("[Healthcheck] Monitoring HTTP endpoint running on :8080/healthz");
});