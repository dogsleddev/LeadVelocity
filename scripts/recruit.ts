/**
 * Contractor recruitment CLI.
 *
 * Hires real San Francisco commercial electrical contractors through Terac to
 * answer a research question about a real permit. They leave a `verified`
 * Finding behind and, if they opt in, become a qualified prospect.
 * See `lib/integrations/terac-recruit.ts` for why those are the same call.
 *
 *   npm run recruit -- feasibility            # FREE. Can Terac source them, at what CPI?
 *   npm run recruit -- feasibility --poll=<id>  # FREE. Check back for the confirmed CPI.
 *   npm run recruit -- filters                # FREE. Show what the audience resolves to.
 *   npm run recruit -- draft                  # FREE. Build the study, do not launch it.
 *
 * There is deliberately no `launch` here. Spending goes through
 * `npm run study -- launch --max-usd=N`, which refuses without a ceiling.
 *
 * FIRE `feasibility` FIRST AND EARLY. It is asynchronous: Terac replies
 * immediately with RECEIVED and a null CPI, prices it out of band, and only then
 * flips to RESPONDED. You cannot decide whether this channel is affordable until
 * that lands.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { appBaseUrl, hasCapability, missingKeys } from '@/lib/config/deployment-env';
import { ensureProject } from '@/lib/integrations/terac';
import {
  createRecruitmentDraft,
  getPanelFeasibility,
  recruitmentTaskDescription,
  requestPanelFeasibility,
  resolveContractorFilters,
  type RecruitmentBrief,
} from '@/lib/integrations/terac-recruit';

const HERO_PERMIT = '202603238106';

function flag(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === null || hit === undefined ? null : hit.slice(name.length + 3);
}

/** Build the brief from the real hero permit in the committed extract. */
function heroBrief(permitNumber: string): RecruitmentBrief {
  const read = (name: string): Array<Record<string, string>> =>
    JSON.parse(readFileSync(resolve(process.cwd(), 'data', name), 'utf8')) as Array<Record<string, string>>;

  const permit = read('permits.json').find((row) => row['permit_number'] === permitNumber);
  if (permit === undefined) {
    throw new Error(`Permit ${permitNumber} is not in data/permits.json. See docs/hero-permits.md.`);
  }
  const gc = read('contacts.json')
    .filter((row) => row['permit_number'] === permitNumber)
    .find((row) => (row['role'] ?? '').toLowerCase().includes('contractor'));

  const cost = Math.max(Number(permit['revised_cost'] ?? 0), Number(permit['estimated_cost'] ?? 0));
  return {
    permitNumber,
    projectAddress: [permit['street_number'], permit['street_name'], permit['street_suffix']]
      .filter((p) => p !== undefined && p !== '')
      .join(' '),
    neighborhood: permit['neighborhoods_analysis_boundaries'] ?? null,
    valuationUsd: Number.isFinite(cost) && cost > 0 ? cost : null,
    scopeSummary: permit['description'] ?? '',
    generalContractor: gc?.['firm_name'] ?? null,
    detailUrl: `${appBaseUrl().replace(/\/+$/, '')}/opportunities/${permitNumber}`,
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'feasibility';

  if (!hasCapability('terac')) {
    console.error(`Terac is not configured. Missing: ${missingKeys('terac').join(', ')}`);
    console.error('See docs/BLOCKERS.md section 4.');
    process.exit(1);
  }

  if (command === 'feasibility') {
    const pollId = flag('poll');
    const result = pollId === null ? await requestPanelFeasibility({}) : await getPanelFeasibility(pollId);
    if (!result.ok) {
      console.error(`Feasibility ${pollId === null ? 'request' : 'poll'} failed: ${result.reason}`);
      process.exit(1);
    }
    const f = result.value;
    console.log(`Feasibility request ${f.requestId}`);
    console.log(`  status:      ${f.status}`);
    console.log(`  participants:${f.submissionCount ?? 'not stated'}`);
    console.log(`  CPI:         ${f.costPerParticipant ?? 'not priced yet'}`);
    if (f.dashboardUrl !== null) console.log(`  dashboard:   ${f.dashboardUrl}`);
    console.log('');
    if (f.status === 'RECEIVED') {
      console.log('Terac is pricing this out of band. Nothing has been spent. Poll with:');
      console.log(`  npm run recruit -- feasibility --poll=${f.requestId}`);
    } else if (f.status === 'RESPONDED') {
      console.log('That CPI is confirmed. Multiply by participant count before deciding.');
    } else {
      console.log(`Status ${f.status} means this panel is not being pursued. The permit-contacts pool remains the fallback.`);
    }
    return;
  }

  if (command === 'filters') {
    const resolved = await resolveContractorFilters();
    if (!resolved.ok) {
      console.error(`Filter resolution failed: ${resolved.reason}`);
      process.exit(1);
    }
    console.log('Audience resolves to:');
    for (const clause of resolved.value) {
      if (clause.optionIds.length === 0) {
        console.log(`  ${clause.slug}: NO MATCH (dropped) tried ${clause.missedSearches.join(', ')}`);
      } else {
        console.log(`  ${clause.slug} ${clause.operator} ${clause.matchedNames.join(', ')}`);
        if (clause.missedSearches.length > 0) {
          console.log(`      (no option for: ${clause.missedSearches.join(', ')})`);
        }
      }
    }
    console.log('\nA dropped clause widens the panel. Check these before spending.');
    return;
  }

  if (command === 'draft') {
    const permitNumber = flag('permit') ?? HERO_PERMIT;
    const brief = heroBrief(permitNumber);

    console.log('Panel will be shown this project:\n');
    console.log(recruitmentTaskDescription(brief));
    console.log('');

    const project = await ensureProject('LeadVelocity');
    if (!project.ok) {
      console.error(`Could not resolve a Terac project: ${project.reason}`);
      process.exit(1);
    }

    const draft = await createRecruitmentDraft({ brief, projectId: project.value });
    if (!draft.ok) {
      console.error(`Draft failed: ${draft.reason}`);
      process.exit(1);
    }
    console.log(`Recruitment study drafted: ${draft.value.opportunityId}`);
    console.log(`  status: ${draft.value.status}`);
    console.log(
      `  cost:   ${draft.value.quotedTotalCents === null ? 'not reported' : `$${(draft.value.quotedTotalCents / 100).toFixed(2)}`}`,
    );
    console.log('\nNothing has been spent. Launch deliberately with:');
    console.log(`  npm run study -- launch --max-usd=<ceiling>`);
    return;
  }

  console.error(`Unknown command "${command}". Use: feasibility | filters | draft`);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('recruit failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
