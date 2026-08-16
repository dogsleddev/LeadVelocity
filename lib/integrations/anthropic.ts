/**
 * The one place an Anthropic client is constructed.
 *
 * Origin: adapter shape and the "degrade, never crash" posture follow SiteVelocity
 * (https://github.com/samshanmukh/SiteVelocity).
 *
 * What this is: a thin, typed wrapper over `@anthropic-ai/sdk` exposing exactly
 * two calls. `completeJson` asks the model for structured output and refuses to
 * hand back anything that has not passed a Zod schema. `completeText` is the
 * drafting path, where free prose is the point.
 *
 * Why it exists:
 *
 * - Hard rule #2 draws a hard line. Deterministic code owns filters, dedupe,
 *   thresholds, scoring arithmetic and billing state. The model is allowed to
 *   interpret, classify, research a contact path and draft. It never produces a
 *   score. Nothing in this file returns a number that feeds `ScoreOutput`, and
 *   nothing should ever be added that does.
 * - A model that returns malformed JSON is a normal Tuesday, not an exception.
 *   `completeJson` retries exactly once, feeding the validation error back so the
 *   second attempt is a repair rather than a reroll. Two failures is a typed
 *   failure result, not a throw and not a fabricated value.
 * - Every call is capability gated. With `ANTHROPIC_API_KEY` absent the call
 *   returns `{ ok: false, skipped: true }` and the caller logs a skipped decision.
 *   An unconfigured deploy loses one capability, not the process.
 *
 * Reading env never happens at import time, so importing this module on a box
 * with no key is safe.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ZodType } from 'zod';

import {
  anthropicModel,
  envInt,
  hasCapability,
  missingKeys,
  requireEnv,
} from '@/lib/config/deployment-env';

/* -------------------------------------------------------------------------- */
/* Result envelope                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Uniform outcome shape shared by every integration adapter in `lib/integrations`.
 *
 * Three states, deliberately distinguishable:
 * - `ok: true`                        the call happened and produced a value.
 * - `ok: false, skipped: true`        the capability is not configured. Expected.
 * - `ok: false, skipped: false`       the call was attempted and failed.
 *
 * Collapsing "not configured" into "failed" would make a half-configured deploy
 * look like an outage, which is exactly the confusion the health probe exists to
 * prevent.
 */
export type AnthropicResult<T> =
  | { ok: true; skipped: false; value: T }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; reason: string };

/** Token accounting, surfaced so the CEO dashboard can price a run honestly. */
export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
}

/** A validated structured completion. */
export interface JsonCompletion<T> {
  value: T;
  model: string;
  /** 1 when the first attempt validated, 2 when the repair attempt was needed. */
  attempts: number;
  usage: AnthropicUsage;
}

/** A free-text completion, used for drafting only. */
export interface TextCompletion {
  text: string;
  model: string;
  usage: AnthropicUsage;
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

const DEFAULT_MAX_TOKENS = 1024;

/**
 * Cached client, keyed on the API key so a key change in a test or a redeploy
 * cannot be served a stale instance.
 */
let cached: { apiKey: string; client: Anthropic } | null = null;

function getClient(): Anthropic {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  if (cached !== null && cached.apiKey === apiKey) return cached.client;

  const client = new Anthropic({
    apiKey,
    maxRetries: envInt('ANTHROPIC_MAX_RETRIES', 2),
    timeout: envInt('ANTHROPIC_TIMEOUT_MS', 60_000),
  });
  cached = { apiKey, client };
  return client;
}

/** True when a model call would actually go out. */
export function anthropicReady(): boolean {
  return hasCapability('anthropic');
}

function skipped<T>(): AnthropicResult<T> {
  return {
    ok: false,
    skipped: true,
    reason: `anthropic capability unconfigured (missing: ${missingKeys('anthropic').join(', ')})`,
  };
}

/* -------------------------------------------------------------------------- */
/* Text extraction and JSON recovery                                          */
/* -------------------------------------------------------------------------- */

/** Concatenate the text blocks of a response, ignoring any non-text block. */
function extractText(message: Anthropic.Messages.Message): string {
  return message.content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function readUsage(message: Anthropic.Messages.Message): AnthropicUsage {
  return {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

/**
 * Pull a JSON document out of a model response.
 *
 * Handles the three shapes that actually turn up: bare JSON, JSON inside a fenced
 * code block, and JSON with a sentence of preamble in front of it. The last case
 * is recovered by slicing between the outermost brace or bracket pair, which is
 * why the check is "does it parse", not "does it look like JSON".
 */
function recoverJson(raw: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  if (trimmed.length > 0) candidates.push(trimmed);

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());

  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      /* try the next recovery strategy */
    }
  }
  return {
    ok: false,
    reason: raw.trim().length === 0 ? 'model returned no text' : 'model output was not valid JSON',
  };
}

/** Flatten Zod issues into one line the model can act on. */
function describeIssues(error: { issues: readonly { path: (string | number)[]; message: string }[] }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface CompleteJsonOptions<T> {
  /** System prompt: role, constraints, and the shape being asked for. */
  system: string;
  /** The user turn. */
  prompt: string;
  /** The contract. Nothing leaves this function without passing it. */
  schema: ZodType<T>;
  /** Output cap. Defaults to 1024. */
  maxTokens?: number;
  /**
   * Sampling temperature. Defaults to 0 because every use here is
   * classification or extraction, where run-to-run drift is a bug.
   */
  temperature?: number;
}

/**
 * Models that reject `temperature` outright.
 *
 * Claude Sonnet 5 returns `400 invalid_request_error: temperature is deprecated
 * for this model`. Sending it is not a warning, it fails the whole request, and
 * because every AI call here degrades gracefully the symptom was silent: the
 * Lead Agent logged `interpretation.failed` and scored permits on the record
 * alone, so leads simply came out a few evidence points light with nothing
 * obviously broken. Omitting the field entirely is the fix; these calls all want
 * deterministic output anyway, which is the default.
 *
 * Matched by prefix so point releases and dated snapshots are covered.
 */
const NO_TEMPERATURE_MODELS: readonly string[] = ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5'];

/** `{ temperature }` for models that accept it, `{}` for models that do not. */
function temperatureParam(model: string, temperature: number): Record<string, number> {
  const rejects = NO_TEMPERATURE_MODELS.some((prefix) => model.startsWith(prefix));
  return rejects ? {} : { temperature };
}

/**
 * Ask the model for JSON and return it only if it satisfies `schema`.
 *
 * On a parse or validation failure the bad output and the exact reason are fed
 * back as a second turn and the call is retried once. That single retry is the
 * whole recovery budget: a model that cannot produce the shape twice in a row is
 * a failure to report, not a loop to spin in.
 *
 * Never throws for a model-side problem. Never returns a partially valid object.
 * Never invents a value to fill a gap.
 */
export async function completeJson<T>(opts: CompleteJsonOptions<T>): Promise<AnthropicResult<JsonCompletion<T>>> {
  if (!anthropicReady()) return skipped<JsonCompletion<T>>();

  const model = anthropicModel();
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? 0;

  const system = `${opts.system}\n\nRespond with a single JSON document and nothing else. No prose, no code fences, no trailing commentary.`;

  const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: opts.prompt }];

  let lastReason = 'no attempt made';
  let usage: AnthropicUsage = { inputTokens: 0, outputTokens: 0 };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let text: string;
    try {
      const response = await getClient().messages.create({
        model,
        max_tokens: maxTokens,
        ...temperatureParam(model, temperature),
        system,
        messages,
      });
      text = extractText(response);
      const turn = readUsage(response);
      usage = {
        inputTokens: usage.inputTokens + turn.inputTokens,
        outputTokens: usage.outputTokens + turn.outputTokens,
      };
    } catch (error) {
      /* Transport, auth, or rate-limit failure. The SDK already retried. */
      return { ok: false, skipped: false, reason: `anthropic request failed: ${describeError(error)}` };
    }

    const recovered = recoverJson(text);
    if (recovered.ok) {
      const parsed = opts.schema.safeParse(recovered.value);
      if (parsed.success) {
        return { ok: true, skipped: false, value: { value: parsed.data, model, attempts: attempt, usage } };
      }
      lastReason = `schema validation failed (${describeIssues(parsed.error)})`;
    } else {
      lastReason = recovered.reason;
    }

    if (attempt === 2) break;

    /* Feed the failure back so attempt two is a repair, not a reroll. */
    messages.push(
      { role: 'assistant', content: text.length > 0 ? text : '(no content returned)' },
      {
        role: 'user',
        content:
          `That response could not be used: ${lastReason}. ` +
          'Return the corrected JSON document only. No prose, no code fences.',
      },
    );
  }

  return { ok: false, skipped: false, reason: `anthropic structured output unusable after 2 attempts: ${lastReason}` };
}

export interface CompleteTextOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Free-text completion, for drafting only.
 *
 * Anything produced here that will reach a human must still pass the copy policy
 * in `lib/copy/templates.ts` before it is sent. This function does not apply that
 * check itself, because it is also used for internal summaries that are never
 * customer facing; the Twilio adapter is the enforcement point for anything that
 * leaves the building.
 */
export async function completeText(opts: CompleteTextOptions): Promise<AnthropicResult<TextCompletion>> {
  if (!anthropicReady()) return skipped<TextCompletion>();

  const model = anthropicModel();
  try {
    const response = await getClient().messages.create({
      model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...temperatureParam(model, opts.temperature ?? 0.3),
      system: opts.system,
      messages: [{ role: 'user', content: opts.prompt }],
    });
    const text = extractText(response);
    if (text.length === 0) {
      return { ok: false, skipped: false, reason: 'anthropic returned no text content' };
    }
    return { ok: true, skipped: false, value: { text, model, usage: readUsage(response) } };
  } catch (error) {
    return { ok: false, skipped: false, reason: `anthropic request failed: ${describeError(error)}` };
  }
}

/** Error text without leaking anything secret-shaped from the SDK internals. */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'unknown error';
}
