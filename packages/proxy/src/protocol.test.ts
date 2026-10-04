import { describe, expect, it } from "vitest";
import {
  cString,
  errorFields,
  FrameDecoder,
  PROTOCOL_V3,
  SSL_REQUEST,
  startupCode,
  startupParams,
} from "./protocol.js";

function startup(params: Record<string, string>): Buffer {
  const body = Buffer.concat([
    ...Object.entries(params).flatMap(([k, v]) => [Buffer.from(`${k}\0${v}\0`)]),
    Buffer.from([0]),
  ]);
  const buf = Buffer.alloc(8 + body.length);
  buf.writeInt32BE(buf.length, 0);
  buf.writeInt32BE(PROTOCOL_V3, 4);
  body.copy(buf, 8);
  return buf;
}

function typed(type: string, payload: Buffer | string): Buffer {
  const p = typeof payload === "string" ? Buffer.from(payload) : payload;
  const buf = Buffer.alloc(5 + p.length);
  buf.write(type, 0, "latin1");
  buf.writeInt32BE(4 + p.length, 1);
  p.copy(buf, 5);
  return buf;
}

const sslRequest = (() => {
  const b = Buffer.alloc(8);
  b.writeInt32BE(8, 0);
  b.writeInt32BE(SSL_REQUEST, 4);
  return b;
})();

describe("FrameDecoder", () => {
  const stream = Buffer.concat([
    startup({ user: "deadheat", database: "shop" }),
    typed("Q", "SELECT 1\0"),
    typed("X", Buffer.alloc(0)),
  ]);

  it("splits a client stream into startup + typed messages", () => {
    const frames = new FrameDecoder(true).push(stream);
    expect(frames.map((f) => f.type)).toEqual(["startup", "Q", "X"]);
    expect(startupParams(frames[0]!)).toEqual({ user: "deadheat", database: "shop" });
    expect(cString(frames[1]!.payload).value).toBe("SELECT 1");
    expect(Buffer.concat(frames.map((f) => f.raw))).toEqual(stream);
  });

  it("gives the same frames however the stream is chunked, even byte by byte", () => {
    for (const size of [1, 2, 3, 7, 13]) {
      const decoder = new FrameDecoder(true);
      const frames = [];
      for (let i = 0; i < stream.length; i += size) {
        frames.push(...decoder.push(stream.subarray(i, i + size)));
      }
      expect(frames.map((f) => f.type)).toEqual(["startup", "Q", "X"]);
      expect(Buffer.concat(frames.map((f) => f.raw))).toEqual(stream);
    }
  });

  it("treats the message after a refused SSL request as untyped again", () => {
    const decoder = new FrameDecoder(true);
    const [ssl] = decoder.push(sslRequest);
    expect(startupCode(ssl!)).toBe(SSL_REQUEST);
    decoder.expectStartup();
    const [plain] = decoder.push(startup({ user: "u" }));
    expect(plain?.type).toBe("startup");
    expect(startupCode(plain!)).toBe(PROTOCOL_V3);
  });

  it("decodes a server stream (no startup phase)", () => {
    const frames = new FrameDecoder(false).push(
      Buffer.concat([typed("C", "SELECT 1\0"), typed("Z", "I")]),
    );
    expect(frames.map((f) => [f.type, f.payload.toString("latin1")])).toEqual([
      ["C", "SELECT 1\0"],
      ["Z", "I"],
    ]);
  });

  it("rejects an impossible length instead of waiting forever", () => {
    const bad = Buffer.from([0x51, 0, 0, 0, 1]); // 'Q' with length 1
    expect(() => new FrameDecoder(false).push(bad)).toThrow(/invalid message length/);
  });
});

describe("errorFields", () => {
  it("reads code and message", () => {
    const payload = Buffer.from('SERROR\0C42P01\0Mrelation "nope" does not exist\0\0');
    expect(errorFields(payload)).toMatchObject({
      S: "ERROR",
      C: "42P01",
      M: 'relation "nope" does not exist',
    });
  });
});
