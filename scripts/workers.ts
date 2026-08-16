/**
 * The worker process: four agent loops, one signal handler, no magic.
 *
 *   npm run workers
 *
 * WHAT THIS IS
 * ------------
 * The scheduler. It owns wall-clock time so no agent has to: each of the four
 * agents is a function that runs one tick, and this file decides when to call
 * them, prints what happened, and stops cleanly when asked.
 *
 * It is NOT a fifth agent (CLAUDE.md hard rule #4). It makes no decisions, writes
 * no events, and touches no domain state. Renaming cron as an agent is exactly
 * the thing the rule forbids, so this stays what it is: a loop.
 *
 * FOUR CHOICES WORTH EXPLAINING
 * -----------------------------
 * 1. FAIL LOUD ON MISSING CONFIG. Without Supabase every tick would read the kill
 *    switch default, fail to log, and spin producing nothing. That is worse than
 *    not starting, so the process prints exactly which keys are missing and exits
 *    non-zero. Every other capability degrades instead: the agents log a skipped
 *    decision and carry on.
 *
 * 2. STAGGERED STARTS. All four cadences divide into each other often enough that
 *    unstaggered loops would land on the same second repeatedly, spiking the
 *    connection pool and interleaving the console output into noise. Each worker
 *    gets its own opening delay.
 *
 * 3. CHAINED TIMEOUTS, NOT INTERVALS. The next tick is scheduled after the
 *    previous one finishes. `setInterval` would let a slow Lead tick stack behind
 *    itself and run two enrichment passes over the same permits at once.
 *
 * 4. THE LOOP CANNOT THROW. `runTick` already converts a failed body into a
 *    logged decision and a typed result, and the call is wrapped again here so
 *    even a failure inside the harness costs one tick rather than the process.
 */
import {
  capabilityReport,
  hasCapability,
  missingKeys,
  optionalEnv,
  tickSeconds,
  type CapabilityName,
} from '@/lib/config/deployment-env';
import {
  activeChannel,
  channelLabel,
  channelReady,
  requiresInboundFirst,
} from '@/lib/delivery/channel';
import type { AgentName } from '@/lib/domain/schemas/core';

import { ceoAgentTick, type CeoTickSummary } from '@/lib/agents/ceo-agent';
import { customerAgentTick, type CustomerTickSummary } from '@/lib/agents/customer-agent';
import { leadAgentTick, type LeadTickSummary } from '@/lib/agents/lead-agent';
import { salesAgentTick, type SalesTickSummary } from '@/lib/agents/sales-agent';
import type { TickResult } from '@/lib/agents/tick';

/* -------------------------------------------------------------------------- */
/* Worker definitions                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One agent loop. `detail` renders the agent's own typed summary into the tail of
 * the console line, so the Lead worker can say what it delivered without the
 * scheduler knowing anything about permits.
 */
interface Worker<T> {
  agent: AgentName;
  intervalMs: number;
  /** Opening delay, so the four loops do not all fire on the same second. */
  startDelayMs: number;
  tick: () => Promise<TickResult<T>>;
  detail: (value: T) => string;
}

/** Type-erased handle the scheduler actually holds. */
interface RunningWorker {
  agent: AgentName;
  intervalMs: number;
  startDelayMs: number;
  run: () => Promise<void>;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  ticks: number;
  failures: number;
  /** Last status printed, so a long halt does not flood the console. */
  lastStatus: TickResult<unknown>['status'] | null;
}

function leadDetail(value: LeadTickSummary): string {
  return `scanned=${value.scanned} rejected=${value.rejected} handled=${value.alreadyHandled} candidates=${value.candidates} delivered=${value.delivered} queued=${value.queued} archived=${value.archived} held=${value.held}`;
}

function salesDetail(value: SalesTickSummary): string {
  return `seeded=${value.poolSeeded} qualified=${value.qualified} classified=${value.classified} prospect=${value.prospect ?? 'none'} sample=${value.sampleScore ?? 'none'} sent=${value.sent} queued=${value.queued}`;
}

function customerDetail(value: CustomerTickSummary): string {
  return `scanned=${value.scanned} replies=${value.withFeedback} applied=${value.applied} settled=${value.alreadySettled}`;
}

function ceoDetail(value: CeoTickSummary): string {
  return `mrr=$${value.economics.mrrUsd} subs=${value.economics.activeSubscribers} delivered=${value.economics.delivered} archived=${value.economics.archived} segments=${value.segments.length} target=${value.allocation?.segment ?? 'held'}`;
}

/* -------------------------------------------------------------------------- */
/* Console output                                                             */
/* -------------------------------------------------------------------------- */

const STATUS_LABEL: Readonly<Record<TickResult<unknown>['status'], string>> = Object.freeze({
  ran: 'ran   ',
  halted: 'halted',
  failed: 'FAILED',
});

function stamp(): string {
  return new Date().toISOString();
}

/** One structured line per tick. Fixed-width columns so a run scans vertically. */
function printTick(result: TickResult<unknown>, detail: string): void {
  const line = [
    stamp(),
    result.agent.padEnd(8),
    STATUS_LABEL[result.status],
    `${String(result.durationMs).padStart(5)}ms`,
    `${String(result.decisions).padStart(2)} decisions`,
    detail,
  ]
    .filter((part) => part.length > 0)
    .join('  ');

  if (result.status === 'failed') console.error(line);
  else console.log(line);
}

/**
 * Which channel is actually carrying messages, and whether both halves of it work.
 *
 * Printed apart from the capability list on purpose. That list reports `linq` and
 * `twilio` side by side and says nothing about which one is live, and "which one
 * is live" is the first thing an operator needs at the venue.
 *
 * The webhook warning is the asymmetry that would otherwise be invisible until it
 * mattered: with `LINQ_WEBHOOK_SECRET` unset, outbound sends perfectly well and
 * inbound is refused as unverified. The company can talk and can never hear back,
 * which reads as quiet rather than as broken. On an inbound-first channel that is
 * worse than it sounds, because nothing then records a first contact and no held
 * message is ever released.
 */
function printChannel(): void {
  const channel = activeChannel();

  console.log(
    `${stamp()}  channel  ${channelLabel()} ${
      channelReady() ? 'ready' : `degraded (missing ${missingKeys(channel).join(', ')})`
    }`,
  );

  if (channel === 'twilio') {
    console.log(
      `${stamp()}  channel  DELIVERY_CHANNEL=twilio, so the fallback is carrying delivery and the Linq path is idle`,
    );
  }

  if (requiresInboundFirst()) {
    console.log(
      `${stamp()}  channel  inbound first: a handle is messaged only after it has texted us, and anything else is queued as prepared`,
    );
  }

  if (channel === 'linq' && optionalEnv('LINQ_WEBHOOK_SECRET') === null) {
    console.warn(
      `${stamp()}  WARNING  LINQ_WEBHOOK_SECRET is not set. Outbound will send and inbound will be refused as unverified.`,
    );
    console.warn(
      `${stamp()}  WARNING  no first contact will be recorded, no queued message will ever be released, and no reply will reach the customer agent.`,
    );
  }
}

function printBanner(): void {
  const cadence = tickSeconds();
  console.log(`${stamp()}  LeadVelocity workers starting`);
  console.log(
    `${stamp()}  cadence  lead ${cadence.lead}s, sales ${cadence.sales}s, customer ${cadence.customer}s, ceo ${cadence.ceo}s`,
  );

  printChannel();

  const report = capabilityReport();
  for (const name of Object.keys(report) as CapabilityName[]) {
    const entry = report[name];
    console.log(
      `${stamp()}  capability ${name.padEnd(9)} ${
        entry.ready ? 'ready' : `degraded (missing ${entry.missing.join(', ')})`
      }`,
    );
  }
  console.log(`${stamp()}  a degraded capability logs a skipped decision, it does not stop a tick`);
}

/* -------------------------------------------------------------------------- */
/* Scheduler                                                                  */
/* -------------------------------------------------------------------------- */

let stopping = false;
const workers: RunningWorker[] = [];

/** Wire one typed worker into the scheduler. */
function register<T>(worker: Worker<T>): void {
  const running: RunningWorker = {
    agent: worker.agent,
    intervalMs: worker.intervalMs,
    startDelayMs: worker.startDelayMs,
    timer: null,
    inFlight: null,
    ticks: 0,
    failures: 0,
    lastStatus: null,
    run: async (): Promise<void> => {
      try {
        const result = await worker.tick();
        running.ticks += 1;
        if (result.status === 'failed') running.failures += 1;

        /*
         * A halted company should be quiet. The first halted tick says so, the
         * rest stay silent until the switch flips back and the worker resumes.
         */
        if (result.status === 'halted' && running.lastStatus === 'halted') {
          running.lastStatus = result.status;
          return;
        }
        running.lastStatus = result.status;

        const detail =
          result.status === 'ran' && result.value !== null
            ? worker.detail(result.value)
            : (result.error ?? (result.status === 'halted' ? 'kill switch is on, nothing ran' : ''));
        printTick(result, detail);
      } catch (error) {
        /* `runTick` should have caught this. If it did not, one tick still dies alone. */
        running.failures += 1;
        console.error(
          `${stamp()}  ${worker.agent.padEnd(8)}  ${STATUS_LABEL.failed}  scheduler caught an escaped error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
  workers.push(running);
}

/** Run a worker now, then schedule the next run once this one has finished. */
function schedule(worker: RunningWorker, delayMs: number): void {
  if (stopping) return;
  worker.timer = setTimeout(() => {
    worker.timer = null;
    if (stopping) return;
    const inFlight = worker.run().finally(() => {
      worker.inFlight = null;
      schedule(worker, worker.intervalMs);
    });
    worker.inFlight = inFlight;
  }, delayMs);
}

/* -------------------------------------------------------------------------- */
/* Shutdown                                                                   */
/* -------------------------------------------------------------------------- */

let shutdownStarted = false;

/**
 * Stop scheduling, let whatever is mid-tick finish, then exit.
 *
 * Letting an in-flight tick finish matters: the Lead worker may have just handed a
 * message to the delivery channel and be about to write `delivered_at`. Killing it
 * there would leave a message on a phone that the database says was never sent.
 */
async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) {
    console.log(`${stamp()}  second ${signal}, exiting immediately`);
    process.exit(130);
  }
  shutdownStarted = true;
  stopping = true;

  console.log(`${stamp()}  ${signal} received, finishing in-flight ticks`);
  for (const worker of workers) {
    if (worker.timer !== null) {
      clearTimeout(worker.timer);
      worker.timer = null;
    }
  }

  await Promise.allSettled(workers.map((worker) => worker.inFlight ?? Promise.resolve()));

  for (const worker of workers) {
    console.log(
      `${stamp()}  ${worker.agent.padEnd(8)}  ${worker.ticks} ticks, ${worker.failures} failed`,
    );
  }
  console.log(`${stamp()}  workers stopped`);
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

function main(): void {
  /*
   * Choice 1. Every agent reads and writes through `lib/store`, and the kill
   * switch itself lives in Postgres, so an unconfigured deploy would spin
   * producing nothing at all. Say what is missing and stop.
   */
  if (!hasCapability('supabase')) {
    console.error('Cannot start the workers: Supabase is not configured.');
    console.error(`Missing environment variables: ${missingKeys('supabase').join(', ')}`);
    console.error('');
    console.error('Every agent reads its work queue and writes its decision log through Supabase,');
    console.error('and the kill switch every worker checks at tick start lives in the settings table.');
    console.error('Set both keys and run `npm run db:migrate` before starting the workers.');
    process.exit(1);
  }

  printBanner();

  const cadence = tickSeconds();

  register<LeadTickSummary>({
    agent: 'lead',
    intervalMs: cadence.lead * 1000,
    startDelayMs: 1_000,
    tick: leadAgentTick,
    detail: leadDetail,
  });

  register<CustomerTickSummary>({
    agent: 'customer',
    intervalMs: cadence.customer * 1000,
    startDelayMs: 4_000,
    tick: customerAgentTick,
    detail: customerDetail,
  });

  register<SalesTickSummary>({
    agent: 'sales',
    intervalMs: cadence.sales * 1000,
    startDelayMs: 8_000,
    tick: salesAgentTick,
    detail: salesDetail,
  });

  register<CeoTickSummary>({
    agent: 'ceo',
    intervalMs: cadence.ceo * 1000,
    startDelayMs: 15_000,
    tick: ceoAgentTick,
    detail: ceoDetail,
  });

  for (const worker of workers) {
    console.log(
      `${stamp()}  scheduling ${worker.agent.padEnd(8)} every ${worker.intervalMs / 1000}s, first tick in ${worker.startDelayMs / 1000}s`,
    );
    schedule(worker, worker.startDelayMs);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
