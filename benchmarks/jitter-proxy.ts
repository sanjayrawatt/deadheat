// A host-side TCP proxy that delays client→server chunks by latency ± jitter, like Toxiproxy's
// latency toxic (upstream stream), with chunk order kept. It exists because Docker Desktop's
// port forwarder intermittently swallows all of a sync burst's 20 fresh connections (they never
// reach Toxiproxy), which hangs a trial for 30s (BENCHMARKS.md §6).
import { connect, createServer, type Server, type Socket } from "node:net";

export interface JitterProxy {
  setLatency(latencyMs: number, jitterMs: number): void;
  close(): Promise<void>;
}

export async function startJitterProxy(
  listenPort: number,
  upstreamPort: number,
): Promise<JitterProxy> {
  let latency = 0;
  let jitter = 0;
  const sockets = new Set<Socket>();

  const server: Server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port: upstreamPort });
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    sockets.add(client).add(upstream);
    let lastRelease = 0;

    client.on("data", (chunk) => {
      const delay = latency + (jitter > 0 ? Math.random() * 2 * jitter - jitter : 0);
      const releaseAt = Math.max(performance.now() + delay, lastRelease);
      lastRelease = releaseAt;
      setTimeout(() => upstream.write(chunk), releaseAt - performance.now());
    });
    upstream.on("data", (chunk) => client.write(chunk));

    upstream.on("close", () => {
      client.end();
      sockets.delete(upstream);
    });
    client.on("close", () => {
      upstream.destroy();
      sockets.delete(client);
    });
    client.on("error", () => client.destroy());
    upstream.on("error", () => upstream.destroy());
  });

  await new Promise<void>((resolve) => server.listen(listenPort, "127.0.0.1", resolve));
  return {
    setLatency(latencyMs, jitterMs) {
      latency = latencyMs;
      jitter = jitterMs;
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
