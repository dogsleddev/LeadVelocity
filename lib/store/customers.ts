/**
 * The subscriber profile (`customers`).
 *
 * One row per paying contractor. In the P0 scope there is exactly one, "Mike's
 * Commercial Electric", but nothing here assumes that; `getPrimaryCustomer()` is
 * a convenience for the single-subscriber demo, not a schema constraint.
 *
 * The profile is the input to fit scoring: trade, territory, minimum project
 * value, preferred uses. `effective_weights` is the one part of the row the
 * Customer Agent is allowed to move in response to feedback. The base profile
 * stays as the human-stated intent so the dashboard can show the two side by
 * side and a judge can see what the system learned.
 *
 * Weights are multipliers applied by the deterministic scorer; storing them here
 * does not let an LLM produce a score (hard rule #2). It lets the scorer weigh
 * components the subscriber has demonstrated they care about.
 */
import { z } from 'zod';

import {
  type CustomerProfile,
  customerProfileSchema,
  tradeSchema,
} from '@/lib/domain/schemas/core';

import {
  dbTimestamp,
  nowIso,
  parseRow,
  parseRows,
  requireClient,
  unwrap,
  unwrapMaybe,
} from './client';

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

/** Score-component multipliers the Customer Agent tunes. */
export type EffectiveWeights = CustomerProfile['effectiveWeights'];

export const effectiveWeightsSchema = z.object({
  fit: z.coerce.number(),
  demand: z.coerce.number(),
  timing: z.coerce.number(),
  value: z.coerce.number(),
  evidence: z.coerce.number(),
});

export const customerStatusSchema = z.enum(['prospect', 'active', 'paused', 'cancelled']);
export type CustomerStatus = z.infer<typeof customerStatusSchema>;

const customerRowSchema = z.object({
  id: z.string().min(1),
  business_name: z.string().min(1),
  trade: tradeSchema,
  territory_zips: z.array(z.string()),
  territory_districts: z.array(z.string()),
  // `numeric` reaches PostgREST as a JSON number, but coerce anyway: the column
  // is arbitrary precision and a driver change must not silently become NaN.
  min_project_value: z.coerce.number(),
  preferred_uses: z.array(z.string()),
  phone: z.string().min(1),
  status: customerStatusSchema,
  effective_weights: effectiveWeightsSchema,
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});

/** A stored customer: the profile plus the identity the database assigned. */
export type CustomerRecord = Omit<CustomerProfile, 'id'> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

function toCustomer(row: unknown, context: string): CustomerRecord {
  const parsed = parseRow(customerRowSchema, row, context);
  return {
    id: parsed.id,
    businessName: parsed.business_name,
    trade: parsed.trade,
    territoryZips: parsed.territory_zips,
    territoryDistricts: parsed.territory_districts,
    minProjectValue: parsed.min_project_value,
    preferredUses: parsed.preferred_uses,
    phone: parsed.phone,
    status: parsed.status,
    effectiveWeights: parsed.effective_weights,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** One customer by id, or `null` when there is no such row. */
export async function getCustomer(id: string): Promise<CustomerRecord | null> {
  const client = requireClient('getCustomer');
  const row = unwrapMaybe(
    await client.from('customers').select('*').eq('id', id).maybeSingle(),
    'getCustomer',
  );
  return row === null ? null : toCustomer(row, 'customers');
}

/**
 * The subscriber the demo runs on.
 *
 * Prefers the oldest `active` account and falls back to the oldest account of
 * any status, so the loop still has someone to fulfil for before checkout has
 * happened. Deterministic ordering by `created_at` keeps repeated runs on the
 * same customer.
 */
export async function getPrimaryCustomer(): Promise<CustomerRecord | null> {
  const client = requireClient('getPrimaryCustomer');

  const active = unwrap(
    await client
      .from('customers')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(1),
    'getPrimaryCustomer (active)',
  );
  const activeRow = active[0];
  if (activeRow !== undefined) return toCustomer(activeRow, 'customers');

  const any = unwrap(
    await client
      .from('customers')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(1),
    'getPrimaryCustomer (any)',
  );
  const anyRow = any[0];
  return anyRow === undefined ? null : toCustomer(anyRow, 'customers');
}

/** Every customer, oldest first. Small table; no pagination needed. */
export async function listCustomers(): Promise<CustomerRecord[]> {
  const client = requireClient('listCustomers');
  const rows = unwrap(
    await client.from('customers').select('*').order('created_at', { ascending: true }),
    'listCustomers',
  );
  return parseRows(customerRowSchema, rows, 'customers').map((row) =>
    toCustomer(row, 'customers'),
  );
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create or update the subscriber profile.
 *
 * Identity resolution, in order: an explicit `id`, then an exact
 * `business_name` match. There is no unique index on `business_name`, so this is
 * an application-level convention rather than a database guarantee. It exists so
 * seeding the demo profile twice produces one customer, not two.
 *
 * `effectiveWeights` is intentionally NOT written here. Seeding a profile must
 * never stomp what the Customer Agent has learned; use
 * {@link updateEffectiveWeights} for that.
 */
export async function upsertCustomer(profile: CustomerProfile): Promise<CustomerRecord> {
  const client = requireClient('upsertCustomer');
  const validated = customerProfileSchema.parse(profile);

  const payload = {
    business_name: validated.businessName,
    trade: validated.trade,
    territory_zips: validated.territoryZips,
    territory_districts: validated.territoryDistricts,
    min_project_value: validated.minProjectValue,
    preferred_uses: validated.preferredUses,
    phone: validated.phone,
    status: validated.status,
    updated_at: nowIso(),
  };

  const existingId = validated.id ?? (await findIdByBusinessName(validated.businessName));

  if (existingId !== null && existingId !== undefined) {
    const row = unwrap(
      await client.from('customers').update(payload).eq('id', existingId).select('*').single(),
      'upsertCustomer (update)',
    );
    return toCustomer(row, 'customers');
  }

  const row = unwrap(
    await client
      .from('customers')
      .insert({ ...payload, effective_weights: validated.effectiveWeights })
      .select('*')
      .single(),
    'upsertCustomer (insert)',
  );
  return toCustomer(row, 'customers');
}

async function findIdByBusinessName(businessName: string): Promise<string | null> {
  const client = requireClient('upsertCustomer');
  const rows = unwrap(
    await client
      .from('customers')
      .select('id')
      .eq('business_name', businessName)
      .order('created_at', { ascending: true })
      .limit(1),
    'upsertCustomer (lookup)',
  );
  const row = rows[0];
  return row === undefined ? null : row.id;
}

/**
 * Replace the score-component multipliers.
 *
 * The Customer Agent calls this after interpreting feedback: `too_small` raises
 * the `value` weight, `wrong_scope` raises `fit`, and so on. The arithmetic that
 * produced the new weights is the caller's business; this function only stores
 * the result and stamps `updated_at` so the dashboard can show when the profile
 * last moved.
 */
export async function updateEffectiveWeights(
  id: string,
  weights: EffectiveWeights,
): Promise<CustomerRecord> {
  const client = requireClient('updateEffectiveWeights');
  const validated = effectiveWeightsSchema.parse(weights);

  const row = unwrap(
    await client
      .from('customers')
      .update({ effective_weights: validated, updated_at: nowIso() })
      .eq('id', id)
      .select('*')
      .single(),
    'updateEffectiveWeights',
  );
  return toCustomer(row, 'customers');
}

/** Move a customer between lifecycle states (`active` after checkout, etc.). */
export async function setCustomerStatus(
  id: string,
  status: CustomerStatus,
): Promise<CustomerRecord> {
  const client = requireClient('setCustomerStatus');
  const row = unwrap(
    await client
      .from('customers')
      .update({ status, updated_at: nowIso() })
      .eq('id', id)
      .select('*')
      .single(),
    'setCustomerStatus',
  );
  return toCustomer(row, 'customers');
}
