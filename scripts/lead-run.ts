/**
 * `npm run lead` - run ONLY the Lead Agent, for a bounded number of ticks.
 *
 * `npm run workers` starts all four agent loops, which includes the Sales Agent,
 * which sends outreach to the demo phone on a timer. That is correct behaviour
 * for a running company and the wrong behaviour when you are sitting at a desk
 * filling the database with real scored jobs.
 *
 * This runs the fulfilment half only: released permits in, shortlisted,
 * enriched, scored, and written to `opportunities` with their Findings and
 * drivers. Nothing here can message a prospect, because the Sales Agent never
 * runs.
 *
 *   npm run lead                    run until there is nothing left to scan
 *   npm run lead -- --ticks=5       run at most 5 ticks
 *   npm run lead -- --no-send       score and save, deliver nothing (no texts)
 *
 * `--no-send` works by unconfiguring the delivery channel for this process
 * only. The Lead Agent then creates the opportunity, scores it, writes its
 * Findings, and logs `opportunity.delivery_skipped`. The row stays `pending`
 * rather than being recorded as delivered, which is the honest state: the work
 * was done, the message was not sent.
 */
import { hasCapability, missingKeys } from '@/lib/config/deployment-env';

function flagNumber(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit === undefined) return fallback;
  const parsed = Number.parseInt(hit.slice(name.length + 3), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const noSend = process.argv.includes('--no-send');
  const maxTicks = flagNumber('ticks', 200);

  if (noSend) {
    // Unconfigure the channel for this process only. channelReady() then reads
    // false and the agent records the opportunity without sending it.
    delete process.env['LINQ_API_V3_API_KEY'];
    delete process.env['TWILIO_ACCOUNT_SID'];
    delete process.env['TWILIO_AUTH_TOKEN'];
    delete process.env['TWILIO_FROM_NUMBER'];
  }

  if (!hasCapability('supabase')) {
    console.error(`Supabase is not configured. Missing: ${missingKeys('supabase').join(', ')}`);
    process.exit(1);
  }

  const { leadAgentTick } = await import('@/lib/agents/lead-agent');
  const { isKillSwitchOn } = await import('@/lib/store/settings');

  if (await isKillSwitchOn()) {
    console.error('Kill switch is ON. Nothing will run until it is flipped off.');
    process.exit(1);
  }

  console.log(noSend ? 'Lead Agent only, delivery disabled for this run.' : 'Lead Agent only. Deliveries WILL send.');

  const totals = { scanned: 0, candidates: 0, delivered: 0, archived: 0, queued: 0, rejected: 0 };
  let tick = 0;

  while (tick < maxTicks) {
    tick += 1;
    const result = await leadAgentTick();

    if (result.status === 'halted') {
      console.log(`tick ${tick}: kill switch flipped on, stopping.`);
      break;
    }
    if (result.status === 'failed' || result.value === null) {
      console.log(`tick ${tick}: failed, ${result.error ?? 'no summary returned'}`);
      break;
    }

    const s = result.value;
    totals.scanned += s.scanned;
    totals.candidates += s.candidates;
    totals.delivered += s.delivered;
    totals.archived += s.archived;
    totals.queued += s.queued;
    totals.rejected += s.rejected;

    console.log(
      `tick ${String(tick).padStart(3)}  scanned ${String(s.scanned).padStart(3)}` +
        `  candidates ${s.candidates}  delivered ${s.delivered}  archived ${s.archived}` +
        `  queued ${s.queued}  rejected ${s.rejected}`,
    );

    // Nothing new to look at: the released backlog is fully triaged.
    if (s.scanned === 0) {
      console.log('Nothing left to scan. Release more permits with `npm run replay` to continue.');
      break;
    }
  }

  console.log('\nTotals across this run:');
  for (const [k, v] of Object.entries(totals)) console.log(`  ${k.padEnd(12)} ${v}`);
}

main().catch((err: unknown) => {
  console.error('lead run failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
