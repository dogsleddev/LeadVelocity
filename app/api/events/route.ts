/**
 * Decision log. `GET /api/events`
 *
 * The append-only record of every decision the four agents have made, newest
 * first. Hard rule #6 says each decision writes a row with a timestamp, an
 * author, a one-sentence summary, and pointers to what it touched; this route
 * is how that log reaches the dashboard, and the log is the demo.
 *
 * It stays a thin read on purpose. No aggregation, no derived narrative, no
 * reordering beyond what the store already guarantees: entries come back sorted
 * by `ts` and then by insertion order, so several decisions written inside the
 * same millisecond during one tick still read in the order they happened rather
 * than in whatever order Postgres scanned them.
 *
 * `agent` is validated against the four real agents (hard rule #4). An unknown
 * value is a 400 naming the four, not an empty result set that would look like
 * a quiet system.
 *
 * Query parameters:
 *   `limit` 1 to 200, default 50
 *   `agent` `ceo | sales | lead | customer`, default all
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { missingKeys } from '@/lib/config/deployment-env';
import { agentNameSchema } from '@/lib/domain/schemas/core';
import { isStoreReady, listEvents } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  agent: agentNameSchema.optional(),
});

function jsonResponse(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse({
    limit: params.get('limit') ?? undefined,
    agent: params.get('agent') ?? undefined,
  });

  if (!parsed.success) {
    return jsonResponse(
      {
        error: 'invalid_query',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      400,
    );
  }

  /*
   * `listEvents` degrades to an empty array without Supabase, which is right
   * for a worker that must not crash and wrong for a dashboard: an empty feed
   * would read as "the company has made no decisions" rather than "this deploy
   * has no database". The route says which.
   */
  if (!isStoreReady()) {
    return jsonResponse(
      {
        error: 'store_unconfigured',
        message: 'Persistence is not configured, so the decision log cannot be read.',
        missing: missingKeys('supabase'),
      },
      503,
    );
  }

  const { limit, agent } = parsed.data;

  try {
    const events = await listEvents({ limit, ...(agent === undefined ? {} : { agent }) });
    return jsonResponse(
      {
        events,
        count: events.length,
        limit,
        filters: { agent: agent ?? null },
        generatedAt: new Date().toISOString(),
      },
      200,
    );
  } catch (error) {
    console.error('[events] read failed:', error);
    return jsonResponse(
      { error: 'store_unavailable', message: 'The decision log could not be read.' },
      503,
    );
  }
}
