// Postgres frontend/backend protocol v3 framing.
// https://www.postgresql.org/docs/current/protocol-message-formats.html
//
// After startup, every message is: 1 type byte + int32 length (counting itself, not the type
// byte) + payload. The client's *first* message has no type byte: int32 length + int32 code.

export const PROTOCOL_V3 = 196608; // 3 << 16
export const SSL_REQUEST = 80877103;
export const GSSENC_REQUEST = 80877104;
export const CANCEL_REQUEST = 80877102;

/** One complete protocol message, with the exact bytes it arrived as. */
export interface Frame {
  /** Message type byte as a character, or "startup" for the untyped first client message. */
  type: string;
  /** Payload after the type byte and length. */
  payload: Buffer;
  /** The whole message, ready to forward unchanged. */
  raw: Buffer;
}

/**
 * Turns a TCP byte stream into whole messages, however the stream is chunked.
 * `untypedFirst` is true on the client→server side, where the first message (and the one after
 * a refused SSL/GSS request) has no type byte.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private expectUntyped: boolean) {}

  /** The next message is untyped again (after we answer an SSL/GSS request ourselves). */
  expectStartup(): void {
    this.expectUntyped = true;
  }

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Frame[] = [];
    for (;;) {
      if (this.expectUntyped) {
        if (this.buf.length < 4) break;
        const len = this.buf.readInt32BE(0);
        if (len < 8) throw new Error(`invalid startup message length ${len}`);
        if (this.buf.length < len) break;
        const raw = this.buf.subarray(0, len);
        frames.push({ type: "startup", payload: raw.subarray(4), raw });
        this.buf = this.buf.subarray(len);
        this.expectUntyped = false;
      } else {
        if (this.buf.length < 5) break;
        const len = this.buf.readInt32BE(1);
        if (len < 4) throw new Error(`invalid message length ${len}`);
        if (this.buf.length < 1 + len) break;
        const raw = this.buf.subarray(0, 1 + len);
        frames.push({ type: String.fromCharCode(raw[0]!), payload: raw.subarray(5), raw });
        this.buf = this.buf.subarray(1 + len);
      }
    }
    return frames;
  }
}

/** The int32 code at the start of a startup-phase payload. */
export function startupCode(frame: Frame): number {
  return frame.payload.readInt32BE(0);
}

/** Reads a null-terminated string starting at `offset`. */
export function cString(buf: Buffer, offset = 0): { value: string; next: number } {
  const end = buf.indexOf(0, offset);
  const stop = end === -1 ? buf.length : end;
  return { value: buf.toString("utf8", offset, stop), next: stop + 1 };
}

/** StartupMessage parameters (user, database, application_name, …). */
export function startupParams(frame: Frame): Record<string, string> {
  const params: Record<string, string> = {};
  let pos = 4; // skip protocol version
  while (pos < frame.payload.length && frame.payload[pos] !== 0) {
    const key = cString(frame.payload, pos);
    const value = cString(frame.payload, key.next);
    params[key.value] = value.value;
    pos = value.next;
  }
  return params;
}

/** ErrorResponse / NoticeResponse fields: severity (S/V), code (C), message (M), … */
export function errorFields(payload: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let pos = 0;
  while (pos < payload.length && payload[pos] !== 0) {
    const code = String.fromCharCode(payload[pos]!);
    const value = cString(payload, pos + 1);
    fields[code] = value.value;
    pos = value.next;
  }
  return fields;
}

/** Human-readable names, for logs and traces. */
export const FRONTEND_MESSAGES: Record<string, string> = {
  startup: "Startup",
  Q: "Query",
  P: "Parse",
  B: "Bind",
  D: "Describe",
  E: "Execute",
  S: "Sync",
  H: "Flush",
  C: "Close",
  X: "Terminate",
  p: "PasswordMessage",
  d: "CopyData",
  c: "CopyDone",
  f: "CopyFail",
  F: "FunctionCall",
};

export const BACKEND_MESSAGES: Record<string, string> = {
  R: "Authentication",
  S: "ParameterStatus",
  K: "BackendKeyData",
  Z: "ReadyForQuery",
  T: "RowDescription",
  D: "DataRow",
  C: "CommandComplete",
  E: "ErrorResponse",
  N: "NoticeResponse",
  I: "EmptyQueryResponse",
  "1": "ParseComplete",
  "2": "BindComplete",
  "3": "CloseComplete",
  n: "NoData",
  t: "ParameterDescription",
  s: "PortalSuspended",
  A: "NotificationResponse",
  G: "CopyInResponse",
  H: "CopyOutResponse",
  W: "CopyBothResponse",
  d: "CopyData",
  c: "CopyDone",
  v: "NegotiateProtocolVersion",
};
