/**
 * The source registry: the only place a data source is declared.
 *
 * Origin: registry pattern adapted from SiteVelocity
 * (https://github.com/samshanmukh/SiteVelocity).
 *
 * CLAUDE.md hard rule #8 says never assume external field names, and record the
 * endpoint plus dataset identity with the source. That is what this file is. It
 * is also the extension point: a new dataset is a new ENTRY here, never a new
 * adapter interface. `SocrataClient` and `httpGetJson` stay as they are.
 *
 * Field mappings for the two DataSF datasets below were live-inspected against
 * the real endpoints and cross-checked against the committed extract in `/data`
 * (10,880 permits, 22,148 contact rows). The CSLB entry deliberately declares
 * `keyField: null`: its schema has NOT been inspected yet, and guessing a column
 * name here is exactly the failure mode the rule exists to prevent.
 */
import { sourceDescriptorSchema, type SourceDescriptor } from '@/lib/domain/schemas/core';

/* -------------------------------------------------------------------------- */
/* Entry shape                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A descriptor plus the three column facts an adapter needs to page, key, and
 * join a dataset. All three are `null`-able because "we have not inspected this
 * dataset yet" is an honest, representable state.
 */
export interface SourceRegistryEntry {
  /** Identity and endpoint, validated by `sourceDescriptorSchema`. */
  readonly descriptor: SourceDescriptor;
  /** Natural key column. `null` when the schema has not been inspected. */
  readonly keyField: string | null;
  /** Column joining this dataset to the permit spine, `null` when it is the spine. */
  readonly joinKey: string | null;
  /** Column an incremental fetch orders and filters on. */
  readonly cursorField: string | null;
  /** Anything a reader needs to know before trusting a mapping. */
  readonly notes: string;
}

/* -------------------------------------------------------------------------- */
/* Entries                                                                    */
/* -------------------------------------------------------------------------- */

const ENTRIES = {
  'datasf.building_permits': {
    descriptor: sourceDescriptorSchema.parse({
      id: 'datasf.building_permits',
      agency: 'City and County of San Francisco (DataSF / DBI)',
      datasetId: 'i98e-djp9',
      name: 'Building Permits',
      endpoint: 'https://data.sfgov.org/resource/i98e-djp9.json',
      kind: 'socrata',
      updateCadence: 'weekly-ish (daily loads observed, publication irregular)',
    }),
    keyField: 'permit_number',
    joinKey: null,
    cursorField: 'data_as_of',
    notes:
      '53 columns, live-inspected. Every value arrives as a string. Coverage measured on ' +
      'n=10,880: revised_cost 96.0%, estimated_cost 99.1%, issued_date 82.2%, approved_date ' +
      '76.4%, completed_date 30.0%. Timestamps are floating and are San Francisco wall time.',
  },
  'datasf.building_permit_contacts': {
    descriptor: sourceDescriptorSchema.parse({
      id: 'datasf.building_permit_contacts',
      agency: 'City and County of San Francisco (DataSF / DBI)',
      datasetId: '3pee-9qhc',
      name: 'Building Permits Contacts',
      endpoint: 'https://data.sfgov.org/resource/3pee-9qhc.json',
      kind: 'socrata',
      updateCadence: 'weekly',
    }),
    keyField: 'id',
    joinKey: 'permit_number',
    cursorField: 'data_as_of',
    notes:
      '24 columns, live-inspected. Joins to the permit spine on permit_number, reliable: 99.6% ' +
      'of permits carry at least one contact row. Coverage measured on n=22,148: license1 63.5%, ' +
      'firm_name 71.4%, sf_business_license_number 40.8%, license2 effectively 0%.',
  },
  'cslb.contractor_license': {
    descriptor: sourceDescriptorSchema.parse({
      id: 'cslb.contractor_license',
      agency: 'California Contractors State License Board',
      datasetId: 'ContractorList',
      name: 'CSLB Contractor License Data Portal',
      endpoint: 'https://www.cslb.ca.gov/onlineservices/dataportal/ContractorList',
      kind: 'http-json',
      updateCadence: 'unknown',
    }),
    keyField: null,
    joinKey: null,
    cursorField: null,
    notes:
      'Schema NOT yet live-inspected. Column names are intentionally left null rather than ' +
      'guessed (CLAUDE.md hard rule #8). Declare keyField and the license-number column here ' +
      'only after inspecting a real response, and treat any lookup as a capability that may ' +
      'be skipped rather than one that may fail the tick.',
  },
} as const satisfies Record<string, SourceRegistryEntry>;

/** Every registered source id, as a literal union. */
export type SourceId = keyof typeof ENTRIES;

/** Frozen lookup. Mutating the registry at runtime is not a supported operation. */
export const SOURCE_REGISTRY: Readonly<Record<SourceId, SourceRegistryEntry>> = Object.freeze(
  ENTRIES,
) as Readonly<Record<SourceId, SourceRegistryEntry>>;

/** All registered ids, in declaration order. */
export const SOURCE_IDS = Object.freeze(Object.keys(ENTRIES) as SourceId[]);

/* -------------------------------------------------------------------------- */
/* Typed getters                                                              */
/* -------------------------------------------------------------------------- */

/** True when `id` names a registered source. Narrows an untrusted string. */
export function isSourceId(id: string): id is SourceId {
  return Object.prototype.hasOwnProperty.call(ENTRIES, id);
}

/**
 * Full registry entry for `id`.
 *
 * Throws on an unknown id, on purpose. A worker asking for a source that does
 * not exist is a wiring bug, and a silent `undefined` would surface later as an
 * unattributed record, which is worse than a loud failure.
 */
export function getSourceEntry(id: string): SourceRegistryEntry {
  if (!isSourceId(id)) {
    throw new Error(`Unknown source id "${id}". Registered: ${SOURCE_IDS.join(', ')}`);
  }
  return SOURCE_REGISTRY[id];
}

/** Descriptor for `id`. Throws on an unknown id. */
export function getSource(id: string): SourceDescriptor {
  return getSourceEntry(id).descriptor;
}

/** Every registered entry, for the health probe and the sources panel. */
export function listSources(): readonly SourceRegistryEntry[] {
  return SOURCE_IDS.map((id) => SOURCE_REGISTRY[id]);
}
