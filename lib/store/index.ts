/**
 * Store barrel.
 *
 * `lib/store` is the only module in the codebase that talks to Postgres.
 * Workers, API routes, and agents import from here; nobody constructs a
 * Supabase client of their own. Two import styles are supported and they are
 * the same functions either way:
 *
 * ```ts
 * import { logEvent, isKillSwitchOn } from '@/lib/store';
 * import { permits, findings } from '@/lib/store';
 * ```
 *
 * The namespaced form is worth reaching for where a call site reads ambiguously
 * on its own, e.g. `subscriptions.setStatus(...)` versus
 * `candidates.setStage(...)`.
 *
 * Every function name across the store is unique, so the flat re-exports below
 * cannot collide. Keep it that way: if a new function would shadow an existing
 * one, the two probably do different things and deserve different names.
 */

/* -------------------------------------------------------------------------- */
/* Namespaced access                                                          */
/* -------------------------------------------------------------------------- */

export * as candidates from './candidates';
export * as customers from './customers';
export * as events from './events';
export * as findings from './findings';
export * as inbound from './inbound';
export * as opportunities from './opportunities';
export * as permits from './permits';
export * as prospects from './prospects';
export * as settings from './settings';
export * as studies from './studies';
export * as subscriptions from './subscriptions';

/* -------------------------------------------------------------------------- */
/* Client and shared plumbing                                                 */
/* -------------------------------------------------------------------------- */

export {
  assertOk,
  chunk,
  dbTimestamp,
  dbTimestampNullable,
  fetchAllPaged,
  getClient,
  isStoreReady,
  isUniqueViolation,
  jsonObjectSchema,
  jsonSchema,
  NO_ROWS_RETURNED,
  nowIso,
  PAGE_SIZE,
  parseRow,
  parseRows,
  requireClient,
  StoreError,
  UNIQUE_VIOLATION,
  unwrap,
  unwrapCount,
  unwrapMaybe,
} from './client';
export type { Database, DbError, DbResponse, Json, JsonObject, StoreClient } from './client';

/* -------------------------------------------------------------------------- */
/* Flat function surface                                                      */
/* -------------------------------------------------------------------------- */

export { getSettings, isKillSwitchOn, setKillSwitch, setReplayState, SETTINGS_ID } from './settings';
export type { AppSettings } from './settings';

export { listEvents, logEvent } from './events';
export type { ListEventsOptions, LogEventInput, LogEventResult } from './events';

export {
  customerStatusSchema,
  effectiveWeightsSchema,
  getCustomer,
  getPrimaryCustomer,
  listCustomers,
  setCustomerStatus,
  updateEffectiveWeights,
  upsertCustomer,
} from './customers';
export type { CustomerRecord, CustomerStatus, EffectiveWeights } from './customers';

export {
  getProspect,
  listQualifiedProspects,
  markContacted,
  prospectIdentityKey,
  prospectSegmentSchema,
  upsertProspects,
} from './prospects';
export type { ProspectInput, ProspectRecord, ProspectSegment, UpsertProspectsResult } from './prospects';

export {
  claimDueReplayRecords,
  countPermits,
  getPermit,
  getPermitHashes,
  listRecentPermits,
  markNotObserved,
  replayProgress,
  stageReplayRecords,
  upsertPermitRecord,
  upsertPermitRecords,
} from './permits';
export type {
  PermitRecord,
  PermitRecordInput,
  ReplayProgress,
  ReplayRecord,
  ReplayRecordInput,
} from './permits';

export {
  candidateStageSchema,
  createCandidate,
  getCandidate,
  getCandidateByPair,
  listCandidatesByStage,
  setStage,
} from './candidates';
export type { CandidateRecord, CandidateStage, CreateCandidateInput } from './candidates';

export { listFindings, readFinding, upsertFinding, upsertFindings } from './findings';
export type { FindingRecord, FindingWriteAction, UpsertFindingResult } from './findings';

export {
  archiveOpportunity,
  createOpportunity,
  getOpportunity,
  getOpportunityByCandidate,
  listOpportunities,
  markDelivered,
  recordFeedback,
} from './opportunities';
export type {
  CreateOpportunityInput,
  ListOpportunitiesOptions,
  OpportunityRecord,
} from './opportunities';

export {
  activateFromStripe,
  getSubscriptionByCustomer,
  hasActiveSubscription,
  recordStripeEventOnce,
  setStatus,
  stripeModeSchema,
  subscriptionStatusSchema,
} from './subscriptions';
export type {
  ActivateFromStripeInput,
  StripeMode,
  SubscriptionRecord,
  SubscriptionStatus,
} from './subscriptions';

export {
  createStudy,
  getCompletedStudy,
  getLatestStudy,
  getStudy,
  markFailed,
  markLaunched,
  recordResults,
  studyStatusSchema,
  studyVariantSchema,
} from './studies';
export type { MessageStudy, StudyResult, StudyStatus, StudyVariant, StudyWinner } from './studies';

/*
 * Inbound contacts and the outbound queue (migration 0002).
 *
 * `isReachable` is the consent gate the Sales Agent consults before composing,
 * and `queueOutbound` is where a message goes when the answer is no. A row in
 * `outbound_queue` is prepared, not delivered; only `markQueuedSent` records a
 * delivery, and only after a provider accepted the message.
 */
export {
  abandonQueued,
  countPending,
  inboundChannelSchema,
  isReachable,
  listInboundContacts,
  listPendingFor,
  markOptedOut,
  markQueuedSent,
  queueOutbound,
  queuePurposeSchema,
  queueStatusSchema,
  recordInboundContact,
} from './inbound';
export type {
  InboundChannel,
  InboundContact,
  QueuedMessage,
  QueueOutboundInput,
  QueueOutboundResult,
  QueuePurpose,
  QueueStatus,
  RecordInboundContactInput,
} from './inbound';
