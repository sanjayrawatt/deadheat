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

/** Parse: prepare a statement. */
export function readParse(payload: Buffer): { name: string; sql: string } {
  const name = cString(payload, 0);
  const sql = cString(payload, name.next);
  return { name: name.value, sql: sql.value };
}

const MAX_PARAM_CHARS = 200;

/** One parameter or column value as text: null, the (truncated) text, or "<binary>". */
function valueAt(buf: Buffer, pos: number, len: number, binary: boolean): string | null {
  if (len === -1) return null;
  if (binary) return "<binary>";
  const text = buf.toString("utf8", pos, pos + len);
  return text.length > MAX_PARAM_CHARS ? `${text.slice(0, MAX_PARAM_CHARS)}…` : text;
}

/** Format code for value `i` given a format-code list (none = all text, one = applies to all). */
function formatOf(codes: number[], i: number): number {
  if (codes.length === 0) return 0;
  return codes.length === 1 ? codes[0]! : (codes[i] ?? 0);
}

export interface BindMessage {
  portal: string;
  statement: string;
  params: (string | null)[];
  resultFormats: number[];
}

/** Bind: attach parameter values to a prepared statement, creating a portal. */
export function readBind(payload: Buffer): BindMessage {
  const portal = cString(payload, 0);
  const statement = cString(payload, portal.next);
  let pos = statement.next;
  const nFormats = payload.readInt16BE(pos);
  pos += 2;
  const formats: number[] = [];
  for (let i = 0; i < nFormats; i++, pos += 2) formats.push(payload.readInt16BE(pos));
  const nParams = payload.readInt16BE(pos);
  pos += 2;
  const params: (string | null)[] = [];
  for (let i = 0; i < nParams; i++) {
    const len = payload.readInt32BE(pos);
    pos += 4;
    params.push(valueAt(payload, pos, len, formatOf(formats, i) === 1));
    if (len > 0) pos += len;
  }
  const nResult = payload.readInt16BE(pos);
  pos += 2;
  const resultFormats: number[] = [];
  for (let i = 0; i < nResult; i++, pos += 2) resultFormats.push(payload.readInt16BE(pos));
  return { portal: portal.value, statement: statement.value, params, resultFormats };
}

/** Execute: run a portal. */
export function readExecute(payload: Buffer): { portal: string } {
  return { portal: cString(payload, 0).value };
}

/** Close: drop a prepared statement ('S') or portal ('P'). */
export function readClose(payload: Buffer): { kind: "S" | "P"; name: string } {
  return {
    kind: String.fromCharCode(payload[0]!) as "S" | "P",
    name: cString(payload, 1).value,
  };
}

/** DataRow column values as text (binary columns become "<binary>"). */
export function readDataRow(payload: Buffer, resultFormats: number[] = []): (string | null)[] {
  const n = payload.readInt16BE(0);
  let pos = 2;
  const values: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    const len = payload.readInt32BE(pos);
    pos += 4;
    values.push(valueAt(payload, pos, len, formatOf(resultFormats, i) === 1));
    if (len > 0) pos += len;
  }
  return values;
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
