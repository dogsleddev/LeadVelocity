/**
 * Minimal typed JSON-over-HTTP client.
 *
 * Origin: fetch/backoff shape adapted from SiteVelocity's source adapters
 * (https://github.com/samshanmukh/SiteVelocity).
 *
 * Why this exists rather than calling `fetch` directly at each call site:
 *
 * - Every outbound call gets a hard timeout. A public agency endpoint that hangs
 *   must fail one worker tick, not wedge the tick loop.
 * - Retries are bounded and only applied to failures that can plausibly succeed
 *   on a second attempt (network, timeout, 408/429/5xx). A 400 from a malformed
 *   SoQL query is a bug in our code and is surfaced immediately.
 * - Every failure mode becomes one typed `HttpJsonError` carrying the URL, the
 *   attempt count, and a bounded excerpt of the body, so a decision-log entry can
 *   say what actually happened instead of "fetch failed".
 * - Nothing is module-global. No shared agent, no shared cache, no ambient
 *   config. Timeouts, retry policy, `fetch`, and `sleep` are all injectable so
 *   tests never touch the network and never wait on a real timer.
 */

/* -------------------------------------------------------------------------- */
/* Defaults and injection points                                              */
/* -------------------------------------------------------------------------- */

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_BASE_MS = 400;
export const DEFAULT_BACKOFF_MAX_MS = 8_000;
/** Bytes of an error body preserved for diagnostics. Bounded so logs stay sane. */
export const ERROR_BODY_EXCERPT_CHARS = 500;

/** The slice of `fetch` this module uses. Narrow on purpose so mocks stay cheap. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Injectable delay, so retry tests do not sleep for real. */
export type SleepLike = (ms: number) => Promise<void>;

const realSleep: SleepLike = (ms) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Why a request failed.
 *
 * - `timeout`       our own deadline fired.
 * - `aborted`       the caller's signal fired. Never retried.
 * - `network`       DNS/TLS/socket level failure, no HTTP status exists.
 * - `http_status`   a response arrived and it was not 2xx.
 * - `invalid_json`  2xx body was not parseable JSON.
 * - `invalid_shape` body parsed but failed the caller's validator.
 */
export type HttpJsonFailureKind =
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'http_status'
  | 'invalid_json'
  | 'invalid_shape';

export class HttpJsonError extends Error {
  readonly kind: HttpJsonFailureKind;
  readonly url: string;
  readonly status: number | null;
  readonly attempts: number;
  readonly bodyExcerpt: string | null;

  constructor(args: {
    kind: HttpJsonFailureKind;
    message: string;
    url: string;
    status?: number | null;
    attempts: number;
    bodyExcerpt?: string | null;
    cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.name = 'HttpJsonError';
    this.kind = args.kind;
    this.url = args.url;
    this.status = args.status ?? null;
    this.attempts = args.attempts;
    this.bodyExcerpt = args.bodyExcerpt ?? null;
  }
}

/* -------------------------------------------------------------------------- */
/* Request / response types                                                   */
/* -------------------------------------------------------------------------- */

/** Query values are stringified; `undefined` and `null` entries are dropped. */
export type QueryParams = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface HttpJsonRequest {
  readonly url: string;
  readonly query?: QueryParams;
  readonly headers?: Readonly<Record<string, string>>;
  /** Per-attempt deadline in milliseconds. */
  readonly timeoutMs?: number;
  /** Total attempts including the first. `1` disables retrying. */
  readonly maxAttempts?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  /** Caller cancellation, honoured immediately and never retried. */
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
  readonly sleepImpl?: SleepLike;
}

export interface HttpJsonResponse<T> {
  readonly data: T;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Fully resolved URL including the query string, useful for provenance. */
  readonly url: string;
  /** How many attempts were spent. `1` means it worked first time. */
  readonly attempts: number;
}

/* -------------------------------------------------------------------------- */
/* URL building                                                               */
/* -------------------------------------------------------------------------- */

/** Append query parameters to a base URL, dropping empty entries. */
export function buildUrl(base: string, query?: QueryParams): string {
  const url = new URL(base);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/* Retry policy                                                               */
/* -------------------------------------------------------------------------- */

/** Statuses worth a second attempt: rate limiting and transient server faults. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableKind(kind: HttpJsonFailureKind): boolean {
  return kind === 'timeout' || kind === 'network';
}

/** Pure exponential backoff, capped. Deterministic: no jitter, no randomness. */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const raw = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, maxMs);
}

/** `Retry-After` in seconds, when the server sent a usable one. */
function retryAfterMs(headers: Readonly<Record<string, string>>, maxMs: number): number | null {
  const raw = headers['retry-after'];
  if (raw === undefined) return null;
  const seconds = Number.parseFloat(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, maxMs);
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function excerpt(body: string): string {
  return body.length > ERROR_BODY_EXCERPT_CHARS
    ? `${body.slice(0, ERROR_BODY_EXCERPT_CHARS)}...`
    : body;
}

/* -------------------------------------------------------------------------- */
/* The call                                                                   */
/* -------------------------------------------------------------------------- */

interface AttemptOutcome {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

async function attemptOnce(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: FetchLike,
  callerSignal: AbortSignal | undefined,
  attempt: number,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const forwardAbort = (): void => controller.abort();
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      clearTimeout(timer);
      throw new HttpJsonError({
        kind: 'aborted',
        message: `Request aborted by caller before dispatch: ${url}`,
        url,
        attempts: attempt,
      });
    }
    callerSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      headers: headersToObject(response.headers),
      body,
    };
  } catch (cause) {
    if (callerSignal?.aborted === true) {
      throw new HttpJsonError({
        kind: 'aborted',
        message: `Request aborted by caller: ${url}`,
        url,
        attempts: attempt,
        cause,
      });
    }
    if (timedOut) {
      throw new HttpJsonError({
        kind: 'timeout',
        message: `Request timed out after ${timeoutMs}ms: ${url}`,
        url,
        attempts: attempt,
        cause,
      });
    }
    throw new HttpJsonError({
      kind: 'network',
      message: `Network failure calling ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      url,
      attempts: attempt,
      cause,
    });
  } finally {
    clearTimeout(timer);
    if (callerSignal !== undefined) callerSignal.removeEventListener('abort', forwardAbort);
  }
}

/**
 * GET a JSON document and validate it with `parse`.
 *
 * `parse` is normally a Zod schema's `.parse`, which is what keeps the "Zod at
 * every boundary" rule true for external data. A validator throw becomes an
 * `HttpJsonError` of kind `invalid_shape` rather than leaking a ZodError to the
 * worker loop.
 */
export async function httpGetJson<T>(
  request: HttpJsonRequest,
  parse: (value: unknown) => T,
): Promise<HttpJsonResponse<T>> {
  const url = buildUrl(request.url, request.query);
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoffBaseMs = request.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMaxMs = request.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const fetchImpl = request.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleepImpl = request.sleepImpl ?? realSleep;

  const init: RequestInit = {
    method: 'GET',
    headers: { accept: 'application/json', ...(request.headers ?? {}) },
  };

  let lastError: HttpJsonError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let outcome: AttemptOutcome;
    try {
      outcome = await attemptOnce(url, init, timeoutMs, fetchImpl, request.signal, attempt);
    } catch (error) {
      const failure =
        error instanceof HttpJsonError
          ? error
          : new HttpJsonError({
              kind: 'network',
              message: `Unexpected transport failure calling ${url}`,
              url,
              attempts: attempt,
              cause: error,
            });
      lastError = failure;
      if (!isRetryableKind(failure.kind) || attempt === maxAttempts) throw failure;
      await sleepImpl(backoffDelayMs(attempt, backoffBaseMs, backoffMaxMs));
      continue;
    }

    if (!outcome.ok) {
      const failure = new HttpJsonError({
        kind: 'http_status',
        message: `HTTP ${outcome.status} from ${url}`,
        url,
        status: outcome.status,
        attempts: attempt,
        bodyExcerpt: excerpt(outcome.body),
      });
      lastError = failure;
      if (!isRetryableStatus(outcome.status) || attempt === maxAttempts) throw failure;
      const advised = retryAfterMs(outcome.headers, backoffMaxMs);
      await sleepImpl(advised ?? backoffDelayMs(attempt, backoffBaseMs, backoffMaxMs));
      continue;
    }

    let decoded: unknown;
    try {
      decoded = outcome.body.length === 0 ? null : (JSON.parse(outcome.body) as unknown);
    } catch (cause) {
      // A 2xx that is not JSON is a contract break, not a transient fault.
      throw new HttpJsonError({
        kind: 'invalid_json',
        message: `Response from ${url} was not valid JSON`,
        url,
        status: outcome.status,
        attempts: attempt,
        bodyExcerpt: excerpt(outcome.body),
        cause,
      });
    }

    let data: T;
    try {
      data = parse(decoded);
    } catch (cause) {
      throw new HttpJsonError({
        kind: 'invalid_shape',
        message: `Response from ${url} did not match the expected shape`,
        url,
        status: outcome.status,
        attempts: attempt,
        bodyExcerpt: excerpt(outcome.body),
        cause,
      });
    }

    return {
      data,
      status: outcome.status,
      headers: outcome.headers,
      url,
      attempts: attempt,
    };
  }

  /* istanbul ignore next -- the loop above always returns or throws. */
  throw (
    lastError ??
    new HttpJsonError({
      kind: 'network',
      message: `Request to ${url} produced no response`,
      url,
      attempts: maxAttempts,
    })
  );
}
