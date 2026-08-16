/**
 * Seed the single demo subscriber and the prospect pool.
 *
 * The migration creates the settings singleton; this creates the one customer
 * the Lead Agent scores against, so the pipeline has a profile to match permits
 * to on the very first tick.
 *
 * Safe to run repeatedly: the customer upsert is keyed on business name and the
 * prospect upsert is keyed on (license number, firm name).
 *
 *   npm run seed
 *   npm run seed -- --with-prospects
 */
import { hasCapability, missingKeys } from '@/lib/config/deployment-env';
import type { CustomerProfile } from '@/lib/domain/schemas/core';

/**
 * Mike's Commercial Electric, the persona from the kickoff pitch anchor.
 * Territory is all of San Francisco: leaving the zip and district allowlists
 * empty means "all of SF" in the shortlist filters, which is what we want for a
 * city-wide electrical subscriber.
 */
const DEMO_CUSTOMER: Omit<CustomerProfile, 'id'> = {
  businessName: "Mike's Commercial Electric",
  trade: 'electrical',
  territoryZips: [],
  territoryDistricts: [],
  // $25,000. Set from the prototype's subscriber profile, which is the
  // owner's stated intent for what Mike would actually chase. A lower floor
  // widens the qualifying pool considerably; see docs/mappings.md.
  minProjectValue: 25_000,
  preferredUses: [
    'office',
    'retail sales',
    'food/beverage hndlng',
    'clinics-medic/dental',
    'school',
    'tourist hotel/motel',
    'warehouse,no frnitur',
    'manufacturing',
  ],
  // `??` is not enough here: .env.local carries DEMO_PHONE_NUMBER as an empty
  // string, which is defined and therefore survives `??`, then fails the
  // schema's min(1). Treat blank as absent.
  phone: (process.env['DEMO_PHONE_NUMBER'] ?? '').trim() || '+10000000000',
  status: 'prospect',
  effectiveWeights: { fit: 1, demand: 1, timing: 1, value: 1, evidence: 1 },
};

async function main(): Promise<void> {
  if (!hasCapability('supabase')) {
    console.error('Cannot seed: Supabase is not configured.');
    console.error(`Missing: ${missingKeys('supabase').join(', ')}`);
    console.error('See docs/BLOCKERS.md section 1.');
    process.exit(1);
  }

  const { upsertCustomer, getPrimaryCustomer } = await import('@/lib/store/customers');
  const { logEvent } = await import('@/lib/store/events');

  const existing = await getPrimaryCustomer();
  const customer = await upsertCustomer(DEMO_CUSTOMER);
  console.log(
    existing
      ? `Customer already present, refreshed: ${customer.businessName}`
      : `Customer created: ${customer.businessName}`,
  );

  if (DEMO_CUSTOMER.phone === '+10000000000') {
    console.warn('DEMO_PHONE_NUMBER is unset, seeded a placeholder. SMS delivery will not reach a phone.');
  }

  if (process.argv.includes('--with-prospects')) {
    const { loadProspectPoolFromExtract, PROSPECT_POOL_SOURCE_ID } = await import(
      '@/lib/integrations/cslb'
    );
    const { upsertProspects } = await import('@/lib/store/prospects');

    const loaded = await loadProspectPoolFromExtract();
    if (!loaded.ok) {
      console.error(`Prospect pool not seeded: ${loaded.reason}`);
      process.exit(1);
    }

    const pool = loaded.value;
    // classification and licenseStatus stay null on purpose: the permit contacts
    // dataset does not carry a CSLB classification and it is not inferable from a
    // firm name. See docs/BLOCKERS.md section 8.
    const written = await upsertProspects(
      pool.prospects.map((seed) => ({
        licenseNumber: seed.licenseNumber,
        firmName: seed.firmName,
        city: seed.city,
        state: seed.state,
        zipcode: seed.zipcode,
        classification: seed.classification,
        licenseStatus: seed.licenseStatus,
        sourceId: seed.sourceId,
      })),
    );

    console.log(
      `Prospect pool seeded from ${pool.extractPath}: ${pool.prospects.length} contractors ` +
        `deduped from ${pool.rowsRead} contact rows (${pool.rowsRejected} rejected).`,
    );
    await logEvent({
      agent: 'sales',
      decision: 'prospect_pool.seeded',
      summary: `Loaded ${pool.prospects.length} licensed contractors active in San Francisco into the prospect pool.`,
      refs: { source: PROSPECT_POOL_SOURCE_ID, written: JSON.stringify(written) },
    });
  }

  console.log('Seed complete.');
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
