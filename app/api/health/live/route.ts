/**
 * Liveness probe. `GET /api/health/live`
 *
 * Origin: probe split adapted from SiteVelocity's deployment pattern
 * (https://github.com/samshanmukh/SiteVelocity).
 *
 * This is the endpoint named in `render.yaml` as `healthCheckPath`, which makes
 * it the answer to exactly one question: is this process up and serving HTTP?
 *
 * It therefore reads no environment variable, opens no database connection, and
 * calls no third party. That restraint is the whole design. A liveness probe
 * that touches Supabase turns a database blip into a rolling restart of a
 * process that was perfectly healthy, and a restart loop during a demo is a
 * worse outcome than a degraded page.
 *
 * Everything a probe would want to know about configuration and connectivity is
 * reported by `GET /api/health/ready` instead, which is allowed to fail.
 */
import { NextResponse } from 'next/server';

/** Node runtime: the rest of the app depends on it, so the probe proves it. */
export const runtime = 'nodejs';

/** Never cached and never statically rendered. A cached probe proves nothing. */
export const dynamic = 'force-dynamic';

/**
 * Captured once at module load. Reported so a reader can tell "the deploy is
 * fine" from "the process just restarted for the fourth time".
 */
const STARTED_AT_MS = Date.now();

export function GET(): NextResponse {
  return NextResponse.json(
    {
      status: 'live',
      service: 'leadvelocity',
      uptimeSeconds: Math.round((Date.now() - STARTED_AT_MS) / 1000),
      ts: new Date().toISOString(),
    },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
