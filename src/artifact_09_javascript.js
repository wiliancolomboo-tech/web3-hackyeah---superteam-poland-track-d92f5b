const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'UP', timestamp: new Date().toISOString(), protocol: 'AegisPay' }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(8080, () => console.log('Telemetry server running on port 8080'));