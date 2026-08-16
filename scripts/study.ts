/**
 * Terac GenPop study CLI.
 *
 * The study is a P0 event rule, and launching it costs real money, so the
 * expensive step is a deliberate human action rather than something a worker
 * tick does on its own. This script is that action.
 *
 *   npm run study -- quote                  # what would it cost? (free)
 *   npm run study -- draft                  # create the draft study (free)
 *   npm run study -- launch --max-usd=25    # SPENDS MONEY, up to the ceiling
 *   npm run study -- results                # poll and show the panel numbers
 *   npm run study -- pause                  # stop a running study
 *
 * `launch` refuses if the quoted cost is unknown or above the ceiling. An
 * unknown cost is treated as over budget, never as free.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  appBaseUrl,
  envInt,
  hasCapability,
  missingKeys,
  monthlyPriceUsd,
} from '@/lib/config/deployment-env';
import type { OutreachCopyContext } from '@/lib/copy/templates';
import {
  createDraftStudy,
  fetchStudyResults,
  launchStudy,
  pauseStudy,
  quoteStudy,
  selectStudyWinner,
  type TeracVariant,
} from '@/lib/integrations/terac';

function flag(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The permit the demo is anchored on. See docs/hero-permits.md. */
const HERO_PERMIT = '202603238106';

/**
 * Build the copy context the variants are drafted over, from the real hero
 * permit in the committed extract.
 *
 * The panel has to read three messages about an actual job, not a placeholder
 * one (hard rule #5). Reading it out of `data/` rather than the database means
 * the study can be drafted before Supabase is even configured.
 */
async function heroOutreachContext(): Promise<OutreachCopyContext> {
  const read = (name: string): Array<Record<string, string>> =>
    JSON.parse(readFileSync(resolve(process.cwd(), 'data', name), 'utf8')) as Array<
      Record<string, string>
    >;

  const permit = read('permits.json').find((row) => row['permit_number'] === HERO_PERMIT);
  if (permit === undefined) {
    throw new Error(
      `Hero permit ${HERO_PERMIT} is not in data/permits.json. Re-run \`npm run extract\` or pick a backup from docs/hero-permits.md.`,
    );
  }

  const contacts = read('contacts.json').filter((row) => row['permit_number'] === HERO_PERMIT);
  const gc = contacts.find((row) => (row['role'] ?? '').toLowerCase().includes('contractor'));

  const cost = Math.max(Number(permit['revised_cost'] ?? 0), Number(permit['estimated_cost'] ?? 0));
  const issued = permit['issued_date'];
  const daysSinceIssued =
    issued === undefined
      ? null
      : Math.max(0, Math.round((Date.now() - new Date(issued).getTime()) / 86_400_000));

  const address = [permit['street_number'], permit['street_name'], permit['street_suffix']]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');

  const base = appBaseUrl().replace(/\/+$/, '');
  return {
    contactFirstName: null,
    territoryLabel: 'San Francisco',
    priceMonthlyUsd: monthlyPriceUsd(),
    minProjectValueUsd: 25_000,
    actionUrl: `${base}/opportunities/${HERO_PERMIT}`,
    opportunity: {
      contactFirstName: null,
      projectAddress: address,
      neighborhood: permit['neighborhoods_analysis_boundaries'] ?? null,
      valuationUsd: Number.isFinite(cost) && cost > 0 ? cost : null,
      scopeSummary: permit['description'] ?? '',
      generalContractor: gc?.['firm_name'] ?? null,
      contactName:
        gc === undefined
          ? null
          : [gc['first_name'], gc['last_name']].filter(Boolean).join(' ') || null,
      openingReason: 'no electrical contractor is on the permit yet',
      daysSinceIssued,
      detailUrl: `${base}/opportunities/${HERO_PERMIT}`,
    },
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'quote';

  if (!hasCapability('terac')) {
    console.error(`Terac is not configured. Missing: ${missingKeys('terac').join(', ')}`);
    console.error('See docs/BLOCKERS.md section 4.');
    process.exit(1);
  }

  const { getLatestStudy, createStudy, markLaunched, recordResults } = await import(
    '@/lib/store/studies'
  );
  const { logEvent } = await import('@/lib/store/events');
  const participants = envInt('TERAC_TARGET_RESPONDENTS', 50);

  if (command === 'quote') {
    const quote = await quoteStudy({ submissionCount: participants });
    if (!quote.ok) {
      console.error(`Quote failed: ${quote.reason}`);
      process.exit(1);
    }
    console.log(`Quote ${quote.value.quoteId}`);
    console.log(`  participants: ${quote.value.submissionCount ?? participants}`);
    console.log(`  total:        ${usd(quote.value.totalCostCents)}`);
    if (quote.value.costPerParticipantCents !== null) {
      console.log(`  per person:   ${usd(quote.value.costPerParticipantCents)}`);
    }
    console.log('\nNothing has been spent. Run `npm run study -- draft` next.');
    return;
  }

  if (command === 'draft') {
    const { sampleOutreachVariants } = await import('@/lib/copy/templates');
    const drafted = sampleOutreachVariants(await heroOutreachContext());
    const variants: TeracVariant[] = drafted.map((variant) => ({
      id: variant.id,
      text: variant.text,
    }));

    const draft = await createDraftStudy({ variants, numParticipants: participants });
    if (!draft.ok) {
      console.error(`Draft failed: ${draft.reason}`);
      process.exit(1);
    }

    await createStudy(variants);
    await markLaunched(draft.value.opportunityId, draft.value.opportunityId);

    console.log(`Draft study created: ${draft.value.opportunityId}`);
    console.log(`  status: ${draft.value.status}`);
    console.log(
      `  cost:   ${draft.value.quotedTotalCents === null ? 'not reported' : usd(draft.value.quotedTotalCents)}`,
    );
    if (draft.value.dashboardUrl !== null) console.log(`  dashboard: ${draft.value.dashboardUrl}`);
    variants.forEach((v, i) => console.log(`\n  Message ${String.fromCharCode(65 + i)}: ${v.text}`));
    console.log('\nNothing has been spent yet. Launch with:');
    console.log('  npm run study -- launch --max-usd=25');
    return;
  }

  const stored = await getLatestStudy();

  if (command === 'launch') {
    const maxUsd = Number.parseFloat(flag('max-usd') ?? '');
    if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
      console.error('launch requires an explicit spending ceiling, e.g. --max-usd=25');
      process.exit(1);
    }
    if (stored === null || stored.studyRef === null) {
      console.error('No drafted study found. Run `npm run study -- draft` first.');
      process.exit(1);
    }

    const launched = await launchStudy(stored.studyRef, {
      maxSpendCents: Math.round(maxUsd * 100),
      authorizedBy: 'operator via npm run study -- launch',
    });
    if (!launched.ok) {
      console.error(`Launch refused: ${launched.reason}`);
      process.exit(1);
    }

    console.log(`Study launched: ${launched.value.opportunityId}`);
    console.log(`  status: ${launched.value.status}`);
    console.log(`  spent:  ${usd(launched.value.spentCents)}`);
    await logEvent({
      agent: 'sales',
      decision: 'study.launched',
      summary: `Launched a general population panel of ${participants} people to test three outreach messages, at a cost of ${usd(launched.value.spentCents)}.`,
      refs: { studyRef: launched.value.opportunityId },
    });
    return;
  }

  if (command === 'results') {
    if (stored === null || stored.studyRef === null) {
      console.error('No study found. Run `npm run study -- draft` first.');
      process.exit(1);
    }
    const results = await fetchStudyResults(stored.studyRef, stored.variants);
    if (!results.ok) {
      console.error(`Results failed: ${results.reason}`);
      process.exit(1);
    }

    console.log(`Study ${results.value.studyRef} is ${results.value.status} (${results.value.rawStatus})`);
    console.log(`  respondents: ${results.value.respondentCount ?? 'not reported'}`);
    for (const v of results.value.variants) {
      const detail = Object.entries(v.selections)
        .map(([k, n]) => `${k}=${n}`)
        .join(' ');
      console.log(`  ${v.label} (${v.variantId}): total ${v.totalSelections}  ${detail}`);
    }

    const winner = selectStudyWinner(results.value);
    if (winner === null) {
      console.log('\nNo selections recorded yet. The panel is still fielding.');
      return;
    }
    console.log(`\nWinner: ${winner.label} (${winner.variantId}) with ${winner.totalSelections} selections.`);

    if (results.value.status === 'complete') {
      const winnerText = stored.variants.find((v) => v.id === winner.variantId)?.text ?? '';
      await recordResults(
        stored.id,
        results.value.variants.map((v) => ({
          variantId: v.variantId,
          label: v.label,
          selections: { ...v.selections },
          shares: { ...v.shares },
          totalSelections: v.totalSelections,
        })),
        { variantId: winner.variantId, text: winnerText },
      );
      await logEvent({
        agent: 'sales',
        decision: 'study.winner_adopted',
        summary: `Panel of ${results.value.respondentCount ?? 'an unreported number of'} people chose ${winner.label} with ${winner.totalSelections} selections. Adopting it as the live outreach copy.`,
        refs: { studyRef: results.value.studyRef, winner: winner.variantId },
      });
      console.log('Winner recorded and adopted as the live outreach copy.');
    } else {
      console.log('Study is not complete yet, so the winner has not been adopted. Poll again later.');
    }
    return;
  }

  if (command === 'pause') {
    if (stored === null || stored.studyRef === null) {
      console.error('No study found.');
      process.exit(1);
    }
    const paused = await pauseStudy(stored.studyRef);
    console.log(paused.ok ? `Paused: ${paused.value.status}` : `Pause failed: ${paused.reason}`);
    return;
  }

  console.error(`Unknown command "${command}". Use: quote | draft | launch | results | pause`);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('study failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
