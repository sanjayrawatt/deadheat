// Records when each request's last byte reaches the server. Runs in its own process,
// so the client's event loop can't skew the timestamps.
//
//   POST /hit        record an arrival
//   GET  /arrivals   return the recorded arrivals (µs, relative to the first) and clear them
//
// Two modes (argv[3]):
//   http  Node's http server. Timestamp on the request's 'end' event: when a Node app could
//         start acting on the request. Includes HTTP parsing and event-loop queueing.
//   raw   Plain TCP. Timestamp on the 'data' event that completes the request: as close to
//         network arrival as user space gets.
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";

const port = Number(process.argv[2] ?? 4199);
const mode = process.argv[3] ?? "http";
let arrivals = [];

function arrivalsJson() {
  const first = arrivals.length ? arrivals.reduce((a, b) => (b < a ? b : a)) : 0n;
  const body = JSON.stringify(arrivals.map((t) => Number(t - first) / 1000));
  arrivals = [];
  return body;
}

const httpServer = createHttpServer((req, res) => {
  if (req.method === "POST" && req.url === "/hit") {
    req.resume();
    req.on("end", () => {
      arrivals.push(process.hrtime.bigint());
      res.writeHead(204).end();
    });
    return;
  }
  if (req.method === "GET" && req.url === "/arrivals") {
    res.writeHead(200, { "content-type": "application/json" }).end(arrivalsJson());
    return;
  }
  res.writeHead(404).end();
});

// Minimal keep-alive HTTP/1.1 over TCP: enough to frame requests with a content-length.
const rawServer = createNetServer((socket) => {
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    const now = process.hrtime.bigint();
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headEnd = buf.indexOf("\r\n\r\n");
      if (headEnd === -1) return;
      const head = buf.subarray(0, headEnd).toString("latin1");
      const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
      const total = headEnd + 4 + length;
      if (buf.length < total) return;
      buf = buf.subarray(total);

      const close = /connection:\s*close/i.test(head);
      const conn = close ? "close" : "keep-alive";
      if (head.startsWith("POST /hit ")) {
        arrivals.push(now);
        socket.write(`HTTP/1.1 204 No Content\r\nconnection: ${conn}\r\n\r\n`);
      } else if (head.startsWith("GET /arrivals ")) {
        const body = arrivalsJson();
        socket.write(
          `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: ${conn}\r\n\r\n${body}`,
        );
      } else {
        socket.write(`HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: ${conn}\r\n\r\n`);
      }
      if (close) return void socket.end();
    }
  });
  socket.on("error", () => {});
});

const server = mode === "raw" ? rawServer : httpServer;
server.listen(port, "127.0.0.1", () => process.send?.("ready"));
