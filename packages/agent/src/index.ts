import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Header Deadheat sends on every request it fires. */
export const REQUEST_ID_HEADER = "x-deadheat-rid";

const VALID_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const TAG = /^\s*\/\*\s*deadheat_rid=/;

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The request id of the code that is running now, if any. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Runs `fn` with `requestId` as the current request. Invalid ids are replaced. */
export function withRequestId<T>(requestId: string | undefined, fn: () => T): T {
  return storage.run({ requestId: normalise(requestId) }, fn);
}

function normalise(id: string | undefined): string {
  return id && VALID_ID.test(id) ? id : `gen-${randomUUID()}`;
}

/** Prefixes `/* deadheat_rid=<id> *\/` when a request is current and the SQL isn't tagged yet. */
export function tagSql(sql: string, requestId = currentRequestId()): string {
  if (!requestId || TAG.test(sql)) return sql;
  return `/* deadheat_rid=${requestId} */ ${sql}`;
}

// ---------------------------------------------------------------------------------------------
// pg instrumentation

type QueryFn = (this: unknown, config: unknown, ...rest: unknown[]) => unknown;
interface PgLike {
  Client: { prototype: { query: QueryFn } };
  Pool: { prototype: { query: QueryFn } };
}

/**
 * Rewrites the query text so it carries the current request id.
 * - string                       → tagged string
 * - { text, ... } without `name` → copy with tagged text
 * - named prepared statements    → untouched: pg rejects one name with two texts, so these
 *                                  queries stay unattributed (documented limitation)
 * - Submittables (cursors etc.)  → `text` tagged in place, unless named
 */
function tagConfig(config: unknown, requestId: string | undefined): unknown {
  if (!requestId) return config;
  if (typeof config === "string") return tagSql(config, requestId);
  if (config && typeof config === "object" && "text" in config) {
    const c = config as { text: unknown; name?: unknown; submit?: unknown };
    if (c.name || typeof c.text !== "string") return config;
    if (typeof c.submit === "function") {
      c.text = tagSql(c.text, requestId);
      return config;
    }
    return { ...c, text: tagSql(c.text, requestId) };
  }
  return config;
}

/**
 * Patches `pg` so every query made inside a request carries its id. Returns an undo function.
 *
 * `Pool.query` is patched as well as `Client.query`, and it tags *eagerly*. When the pool is
 * exhausted, pg-pool runs the waiting query's callback from whichever request releases a
 * client, so tagging later, inside `Client.query`, would use the wrong request's context.
 */
export function instrumentPg(pg: PgLike): () => void {
  const originals = [
    [pg.Client.prototype, pg.Client.prototype.query],
    [pg.Pool.prototype, pg.Pool.prototype.query],
  ] as const;
  for (const [proto, original] of originals) {
    proto.query = function (this: unknown, config: unknown, ...rest: unknown[]) {
      return original.call(this, tagConfig(config, currentRequestId()), ...rest);
    };
  }
  return () => {
    for (const [proto, original] of originals) proto.query = original;
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP integrations

interface FastifyLike {
  addHook(
    name: "onRequest",
    hook: (
      req: { headers: Record<string, string | string[] | undefined> },
      reply: unknown,
      done: () => void,
    ) => void,
  ): unknown;
}

/** Fastify: every request (and everything it awaits) runs with its Deadheat request id. */
export function registerFastify(app: FastifyLike): void {
  app.addHook("onRequest", (req, _reply, done) => {
    withRequestId(headerValue(req.headers[REQUEST_ID_HEADER]), done);
  });
}

/** Express / Connect style middleware. */
export function middleware() {
  return (
    req: { headers: Record<string, string | string[] | undefined> },
    _res: unknown,
    next: () => void,
  ) => withRequestId(headerValue(req.headers[REQUEST_ID_HEADER]), next);
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
