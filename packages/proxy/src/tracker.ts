import {
  cString,
  errorFields,
  readBind,
  readClose,
  readDataRow,
  readExecute,
  readParse,
  type Frame,
} from "./protocol.js";

export type TxStatus = "I" | "T" | "E"; // idle, in transaction, failed transaction

export interface ConnectionOpenEvent {
  type: "connection-open";
  connectionId: number;
  user?: string;
  database?: string;
  applicationName?: string;
}

export interface QueryEvent {
  type: "query";
  connectionId: number;
  protocol: "simple" | "extended";
  /** SQL text, without the agent's `/* deadheat_rid=… *\/` tag. */
  sql: string;
  /** The HTTP request this query belongs to, read from the agent's SQL comment. */
  requestId?: string;
  /** Bound parameter values (extended protocol), as text. */
  params?: (string | null)[];
  /** performance.now() when the query was sent (Q or Execute). */
  startedAt: number;
  durationMs: number;
  rows: number;
  /** Values of the first result row, as text. */
  firstRow?: (string | null)[];
  /** One CommandComplete tag per statement, e.g. ["INSERT 0 1"]. */
  commandTags: string[];
  error?: { code: string; message: string };
  /** Transaction status reported by the ReadyForQuery that followed. */
  txStatus: TxStatus;
  /** How long the proxy held this query's result back (race-window widening). */
  heldMs?: number;
}

export interface ConnectionCloseEvent {
  type: "connection-close";
  connectionId: number;
  queries: number;
}

export type ProxyEvent = ConnectionOpenEvent | QueryEvent | ConnectionCloseEvent;

const TAG = /^\s*\/\*\s*deadheat_rid=([A-Za-z0-9._:-]+)\s*\*\/\s*/;

/** Splits the agent's request-id comment off the front of a query. */
export function splitRequestTag(sql: string): { sql: string; requestId?: string } {
  const m = TAG.exec(sql);
  return m ? { sql: sql.slice(m[0].length), requestId: m[1]! } : { sql };
}

interface Running {
  protocol: "simple" | "extended";
  sql: string;
  params?: (string | null)[];
  resultFormats: number[];
  startedAt: number;
  endedAt?: number;
  rows: number;
  firstRow?: (string | null)[];
  commandTags: string[];
  error?: { code: string; message: string };
  /** Set once the proxy has decided whether to hold this query's result. */
  holdDecided?: boolean;
  heldMs?: number;
}

/** The query whose response is arriving now, as the proxy's hold logic sees it. */
export interface Responding {
  sql: string;
  requestId?: string;
  /** Decide once per query: returns the hold in ms, or 0. */
  decide(holdFor: (sql: string, requestId: string | undefined) => number): number;
}

/**
 * Follows one connection's messages and emits a QueryEvent per completed query.
 *
 * Simple protocol: Q → (T, D…, C)+ | E → Z.
 * Extended protocol: P/B/E… S. Executes complete in the order they were sent (D…, then
 * C/I/s, or E). After an error the server skips everything up to Sync. Events are emitted
 * at ReadyForQuery, which also carries the transaction status.
 */
export class QueryTracker {
  count = 0;
  private simple: Running | undefined;
  private readonly statements = new Map<string, string>();
  private readonly portals = new Map<
    string,
    { sql: string; params: (string | null)[]; resultFormats: number[] }
  >();
  private queue: Running[] = [];
  private done: Running[] = [];

  constructor(
    private readonly connectionId: number,
    private readonly emit: (e: ProxyEvent) => void,
  ) {}

  frontend(frame: Frame): void {
    switch (frame.type) {
      case "Q":
        this.simple = {
          protocol: "simple",
          sql: cString(frame.payload).value,
          resultFormats: [],
          startedAt: performance.now(),
          rows: 0,
          commandTags: [],
        };
        break;
      case "P": {
        const { name, sql } = readParse(frame.payload);
        this.statements.set(name, sql);
        break;
      }
      case "B": {
        const bind = readBind(frame.payload);
        this.portals.set(bind.portal, {
          sql: this.statements.get(bind.statement) ?? "<unknown statement>",
          params: bind.params,
          resultFormats: bind.resultFormats,
        });
        break;
      }
      case "E": {
        const portal = this.portals.get(readExecute(frame.payload).portal);
        this.queue.push({
          protocol: "extended",
          sql: portal?.sql ?? "<unknown portal>",
          params: portal?.params ?? [],
          resultFormats: portal?.resultFormats ?? [],
          startedAt: performance.now(),
          rows: 0,
          commandTags: [],
        });
        break;
      }
      case "C": {
        const { kind, name } = readClose(frame.payload);
        (kind === "S" ? this.statements : this.portals).delete(name);
        break;
      }
    }
  }

  backend(frame: Frame): void {
    const q = this.simple ?? this.queue[0];
    switch (frame.type) {
      case "D":
        if (!q) break;
        q.rows++;
        q.firstRow ??= readDataRow(frame.payload, q.resultFormats);
        break;
      case "C":
        if (!q) break;
        q.commandTags.push(cString(frame.payload).value);
        if (!this.simple) this.finishHead();
        break;
      case "I": // EmptyQueryResponse
      case "s": // PortalSuspended (row limit reached)
        if (q && !this.simple) this.finishHead();
        break;
      case "E":
        if (!q) break;
        q.error = toError(frame.payload);
        if (!this.simple) {
          this.finishHead();
          this.queue = []; // the server skips the rest of the batch until Sync
        }
        break;
      case "Z": {
        const txStatus = String.fromCharCode(frame.payload[0]!) as TxStatus;
        if (this.simple) {
          this.simple.endedAt = performance.now();
          this.done.push(this.simple);
          this.simple = undefined;
        }
        for (const r of this.done) this.emitQuery(r, txStatus);
        this.done = [];
        this.queue = [];
        break;
      }
    }
  }

  /** The query the next backend frame belongs to, if any. */
  responding(): Responding | undefined {
    const r = this.simple ?? this.queue[0];
    if (!r) return undefined;
    const { sql, requestId } = splitRequestTag(r.sql);
    return {
      sql,
      ...(requestId ? { requestId } : {}),
      decide(holdFor) {
        if (r.holdDecided) return 0;
        r.holdDecided = true;
        const ms = holdFor(sql, requestId);
        if (ms > 0) r.heldMs = ms;
        return ms;
      },
    };
  }

  private finishHead(): void {
    const head = this.queue.shift();
    if (!head) return;
    head.endedAt = performance.now();
    this.done.push(head);
  }

  private emitQuery(r: Running, txStatus: TxStatus): void {
    this.count++;
    const { sql, requestId } = splitRequestTag(r.sql);
    this.emit({
      type: "query",
      connectionId: this.connectionId,
      protocol: r.protocol,
      sql,
      ...(requestId ? { requestId } : {}),
      ...(r.protocol === "extended" ? { params: r.params ?? [] } : {}),
      startedAt: r.startedAt,
      durationMs: (r.endedAt ?? performance.now()) - r.startedAt,
      rows: r.rows,
      ...(r.firstRow ? { firstRow: r.firstRow } : {}),
      commandTags: r.commandTags,
      ...(r.error ? { error: r.error } : {}),
      txStatus,
      ...(r.heldMs ? { heldMs: r.heldMs } : {}),
    });
  }
}

function toError(payload: Buffer): { code: string; message: string } {
  const f = errorFields(payload);
  return { code: f.C ?? "", message: f.M ?? "" };
}
