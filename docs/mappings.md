# Source registry and field mappings

What this document is: the measured contract between the two DataSF datasets LeadVelocity ingests and the
normalized shapes the rest of the codebase reads. Every percentage below was counted on the committed extract
in `/data`, not copied from the kickoff. Where the kickoff assumed something and the data disagrees, the
disagreement is recorded in "Corrections to the kickoff assumptions" at the end rather than quietly fixed.

This satisfies CLAUDE.md hard rule #8: never assume external field names, inspect the schema and record the
endpoint plus dataset identity in the source registry entry.

Measured against:

| File | Rows | SHA note |
| --- | --- | --- |
| `data/permits.json` | 10,880 | 10,049 distinct `permit_number` |
| `data/contacts.json` | 22,148 | 10,013 distinct `permit_number` |
| `data/manifest.json` | 2 source entries | provenance, quoted below verbatim |

All measurements in this document were produced by node scripts reading those three files directly. Nothing
here is estimated.

---

## 1. Source registry identity

Both entries map onto `sourceDescriptorSchema` in `lib/domain/schemas/core.ts`
(`id`, `agency`, `datasetId`, `name`, `endpoint`, `kind`, `updateCadence`).

### 1.1 Building Permits

| Registry field | Value |
| --- | --- |
| `id` | `datasf.building_permits` |
| `agency` | City and County of San Francisco (DataSF / Department of Building Inspection) |
| `datasetId` | `i98e-djp9` (Socrata 4x4) |
| `name` | Building Permits |
| `endpoint` | `https://data.sfgov.org/resource/i98e-djp9.json` |
| `kind` | `socrata` |
| `updateCadence` | Daily. Evidenced, not claimed: see the cadence measurement below. |
| Rows in extract | 10,880 |
| Retrieval window | `filed_date > 2026-02-15T00:00:00` (manifest `window.filed_date_after`) |
| `retrieved_at` | `2026-08-15T16:47:00.415Z` |

### 1.2 Building Permits Contacts

| Registry field | Value |
| --- | --- |
| `id` | `datasf.building_permit_contacts` |
| `agency` | City and County of San Francisco (DataSF / Department of Building Inspection) |
| `datasetId` | `3pee-9qhc` (Socrata 4x4) |
| `name` | Building Permits Contacts |
| `endpoint` | `https://data.sfgov.org/resource/3pee-9qhc.json` |
| `kind` | `socrata` |
| `updateCadence` | Daily. |
| Rows in extract | 22,148 |
| Join key | `permit_number` |
| `retrieved_at` | `2026-08-15T16:47:00.415Z` |

### 1.3 Cadence, measured rather than claimed

Both datasets carry agency-reported currency fields. Their spacing is what the cadence claim rests on:

- Permits: `data_as_of` and `data_loaded_at` are 100.00% populated. `data_loaded_at` runs roughly four to five
  hours behind `data_as_of` on the same calendar day (hero record: `data_as_of` `2026-04-12T01:05:02.000`,
  `data_loaded_at` `2026-04-12T05:30:44.519`). Successive values step one day at a time.
- Contacts: same pair, both 100.00% populated, same one-day step (hero contacts:
  `data_as_of` `2026-03-24T05:06:28.000`, `data_loaded_at` `2026-03-25T05:47:04.000`).

Ingestion should treat one poll per day as sufficient and should carry `data_as_of` / `data_loaded_at` into
`provenanceSchema.dataAsOf` / `dataLoadedAt` unchanged, so a stale dataset is visible rather than inferred.

### 1.4 Replay descriptor

The replay harness reads the same records from disk. It uses a distinct registry entry with
`kind: 'replay'` and the same `datasetId`, so a replayed record is never mistaken for a live one and the UI
badge (CLAUDE.md hard rule #5) can be driven off the descriptor rather than a side channel.

---

## 2. Permits: field mapping

Legend for "Populated": share of the 10,880 rows where the key is present and not an empty string. Socrata
omits empty keys entirely, so an absent key and an empty value are the same observation. "Type" is the JSON
type actually observed on the wire, which is `string` for everything except `location`.

Normalized paths below are the keys written into `permit_records.normalized` (jsonb) and mirrored by the
TypeScript normalizer. Anything that becomes a stored fact about a candidate also becomes a `Finding` with an
evidence label; the mapping notes call out which fields are allowed to produce `unknown`.

### 2.1 Identity and classification

| Source field | Normalized field | Type | Populated | Notes |
| --- | --- | --- | --- | --- |
| `permit_number` | `permitNumber` | string | 100.00% | Agency permit id. **Not unique in this dataset.** 726 permit numbers occupy 2 to 9 rows each, 831 rows beyond the first. See correction C1. |
| `record_id` | `recordId` | string | 100.00% | Socrata row identity. 10,879 distinct of 10,880 (one collision, `1750952164605`). Closest thing to a true row key, still not perfect. |
| `permit_type` | `permitType` | string | 100.00% | Numeric code as a string, values `1` through `9`. |
| `permit_type_definition` | `permitTypeDefinition` | string \| null | 98.18% | The 198 absent rows are all `permit_type` `9`, which is the solar PV bucket. See correction C7. Absent maps to `null` + `unknown`, never to a guessed label. |

`permit_type` to `permit_type_definition`, complete and measured:

| Code | Definition | Rows |
| --- | --- | --- |
| `8` | otc alterations permit | 9,887 |
| `3` | additions alterations or repairs | 538 |
| `9` | *(no definition in the extract; descriptions show solar PV)* | 198 |
| `4` | sign - erect | 177 |
| `6` | demolitions | 43 |
| `2` | new construction wood frame | 23 |
| `1` | new construction | 9 |
| `7` | wall or painted sign | 3 |
| `5` | grade or quarry or fill or excavate | 2 |

### 2.2 Address and geography

| Source field | Normalized field | Type | Populated | Notes |
| --- | --- | --- | --- | --- |
| `street_number` | `address.streetNumber` | string | 100.00% | Differs between rows of the same permit on multi-address permits. Primary driver of the duplicate-row behaviour in C1. |
| `street_number_suffix` | `address.streetNumberSuffix` | string \| null | 1.70% | 185 rows. Values like `A`, `B`. |
| `street_name` | `address.streetName` | string | 100.00% | Mixed case, not normalized by the agency. |
| `street_suffix` | `address.streetSuffix` | string \| null | 98.68% | `St`, `Av`, and so on. |
| `unit` | `address.unit` | string \| null | 12.47% | 1,357 rows. **`"0"` is a common placeholder, not a real unit** (the hero record carries `unit: "0"`). Treat `"0"` as no unit. |
| `unit_suffix` | `address.unitSuffix` | string \| null | 1.49% | 162 rows, free text like `FRONT BLDG`. |
| `block` | `address.block` | string | 100.00% | Assessor block, zero-padded (`0259`). Keep as a string; leading zeros are load bearing. |
| `lot` | `address.lot` | string | 100.00% | Assessor lot, zero-padded (`026`). Same rule. |
| `zipcode` | `address.zipcode` | string \| null | 99.91% | 28 distinct values, every one begins `941`. Safe as the territory allowlist key. |
| `supervisor_district` | `address.supervisorDistrict` | string \| null | 99.97% | `1` through `11` as strings. |
| `neighborhoods_analysis_boundaries` | `address.neighborhood` | string \| null | 99.97% | 41 distinct values, for example `Financial District/South Beach`. |
| `primary_address_flag` | `address.isPrimary` | boolean | 92.37% | `Y` only; absent means not primary. **This is the deduplication key.** Of the 726 duplicate groups, 725 have exactly one row flagged `Y` and 1 has more than one. Zero groups have none. |
| `location` | `geo.lat` / `geo.lon` | object (GeoJSON Point) | 99.97% | The only non-string field on the wire. `coordinates` is `[lon, lat]` in that order. Do not swap. |
| `point_source` | `geo.pointSource` | string \| null | 99.97% | `eas_address_point` (10,798), `parcel_centroid` (79). A parcel centroid is a coarser fix and should degrade geocode confidence. |

### 2.3 Lifecycle and dates

Every date arrives as `YYYY-MM-DDTHH:MM:SS.mmm` with **no timezone designator**. See correction C4.

| Source field | Normalized field | Type | Populated | Notes |
| --- | --- | --- | --- | --- |
| `status` | `status` | string | 100.00% | Ten values, complete list below. |
| `status_date` | `statusDate` | string \| null | 100.00% | Tracks the most recent status transition. |
| `permit_creation_date` | `createdDate` | string \| null | 100.00% | Ranges back to 2023-04-29 even though the extract window is on `filed_date`. Not a substitute for `filed_date`. |
| `filed_date` | `filedDate` | string \| null | 100.00% | The window field. Range in this extract: `2026-02-15T15:11:24.000` to `2026-08-14T18:05:07.000`. Zero rows violate the manifest window. |
| `approved_date` | `approvedDate` | string \| null | 76.40% | 8,312 rows. Absent maps to `null` + `unknown`. |
| `issued_date` | `issuedDate` | string \| null | 82.22% | 8,946 rows. Absent maps to `null` + `unknown`. |
| `completed_date` | `completedDate` | string \| null | 30.05% | 3,269 rows. Mostly absent by design; an open permit has no completion. |
| `first_construction_document_date` | `firstConstructionDocumentDate` | string \| null | 0.01% | **1 row in 10,880.** Effectively unusable. Do not build a timing signal on it. |
| `last_permit_activity_date` | `lastActivityDate` | string \| null | 99.93% | The most reliable freshness signal after `status_date`. |
| `data_as_of` | `provenance.dataAsOf` | string \| null | 100.00% | Agency-reported currency. |
| `data_loaded_at` | `provenance.dataLoadedAt` | string \| null | 100.00% | Portal load time, runs a few hours behind `data_as_of`. |

Status distribution, complete:

| Status | Rows | Share |
| --- | --- | --- |
| issued | 5,551 | 51.0% |
| complete | 3,266 | 30.0% |
| filed | 1,860 | 17.1% |
| cancelled | 61 | 0.6% |
| reinstated | 43 | 0.4% |
| withdrawn | 42 | 0.4% |
| approved | 33 | 0.3% |
| suspend | 19 | 0.2% |
| denied | 3 | 0.0% |
| expired | 2 | 0.0% |

Timing observed across the 8,946 rows carrying both `filed_date` and `issued_date`: p10 0.0 days, p50 0.1 days,
p90 28.2 days. Zero negative intervals. The median is near zero because over-the-counter alterations dominate
the dataset and issue the same day; the projects worth chasing sit in the long tail (the hero took 18.0 days).

### 2.4 Valuation

| Source field | Normalized field | Type | Populated | Notes |
| --- | --- | --- | --- | --- |
| `estimated_cost` | `cost.estimated` | string -> number \| null | 99.05% | 10,777 rows. Applicant's figure at filing. |
| `revised_cost` | `cost.revised` | string -> number \| null | 95.96% | 10,440 rows. **687 rows (6.31%) carry the literal string `"0.0"`.** |
| *(derived)* | `cost.valuation` | number \| null | 99.90% | `max(revised, estimated)` after numeric coercion, treating absent as 0 but absent-on-both as `null`. |

Why `max` and not "prefer revised": 654 rows have `revised_cost` `"0.0"` while `estimated_cost` is positive, so
preferring revised would zero out a real project. In the other direction `estimated_cost` exceeds
`revised_cost` on 856 rows and `revised_cost` exceeds `estimated_cost` on 2,139 rows, so neither field
dominates. `max` is the only rule that never invents a zero. Only 11 rows (0.10%) have neither field, and those
are the only rows where valuation is honestly `null` + `unknown`.

Zero non-numeric cost strings were found across both fields in all 10,880 rows, so coercion via `Number()` is
safe provided the result is checked with `Number.isFinite`. Do not skip the check on the strength of this
measurement; the next extract is not bound by it.

Valuation distribution over the 10,869 rows that have one: p50 $20,000, p90 $195,602, p99 $2,000,000,
max $90,000,000. Rows at or above the subscriber's $100,000 floor: 1,893 (17.40%).

### 2.5 Building, use, and occupancy

| Source field | Normalized field | Type | Populated | Notes |
| --- | --- | --- | --- | --- |
| `existing_use` | `use.existing` | string \| null | 98.15% | 64 distinct values. The commercial / residential split lives here. |
| `proposed_use` | `use.proposed` | string \| null | 97.08% | Almost always equal to `existing_use` on alteration permits. |
| `existing_units` | `use.existingUnits` | string -> number \| null | 78.59% | Decimal strings (`1.0`). |
| `proposed_units` | `use.proposedUnits` | string -> number \| null | 78.65% | Same. |
| `existing_occupancy` | `use.existingOccupancy` | string \| null | 98.89% | Building-code occupancy letters. **Can be a comma-joined list** (`M,B`, `B,A-2,M`). Parse as a set, not a scalar. |
| `proposed_occupancy` | `use.proposedOccupancy` | string \| null | 97.62% | Same. |
| `number_of_existing_stories` | `building.existingStories` | string -> number \| null | 91.27% | |
| `number_of_proposed_stories` | `building.proposedStories` | string -> number \| null | 90.34% | |
| `existing_construction_type` | `building.existingConstructionType` | string \| null | 91.04% | Code as a string; both `5` and `V` appear for the same concept. |
| `existing_construction_type_description` | `building.existingConstructionTypeDescription` | string \| null | 91.02% | |
| `proposed_construction_type` | `building.proposedConstructionType` | string \| null | 90.14% | |
| `proposed_construction_type_description` | `building.proposedConstructionTypeDescription` | string \| null | 90.12% | |
| `plansets` | `building.plansets` | string -> number \| null | 99.55% | |
| `description` | `description` | string \| null | 99.97% | Lowercase free text, frequently misspelled by the applicant. The only field carrying trade scope. AI reads this for interpretation; deterministic code must not depend on it alone. |

Commercial `existing_use` values present in the extract, with counts. This is the measured universe, not a
guess, and it is what the shortlist filter should be written against:

| Use | Rows | | Use | Rows |
| --- | --- | --- | --- | --- |
| office | 1,245 | | printing plant | 4 |
| retail sales | 328 | | massage parlor | 4 |
| food/beverage hndlng | 265 | | muni carbarn | 4 |
| tourist hotel/motel | 50 | | animal sale or care | 4 |
| school | 50 | | garment shops | 4 |
| church | 42 | | day care, non-res | 4 |
| clinics-medic/dental | 39 | | moving & storage | 3 |
| warehouse,no frnitur | 37 | | day care center | 3 |
| prkng garage/private | 33 | | club | 3 |
| lending institution | 32 | | wholesale sales | 3 |
| manufacturing | 25 | | automobile sales | 3 |
| barber/beauty salon | 23 | | amusement center | 3 |
| prkng garage/public | 18 | | museum | 3 |
| filling/service stn | 17 | | car wash | 3 |
| power plant | 16 | | nite club | 2 |
| laundry/laundromat | 15 | | jail | 2 |
| recreation bldg | 14 | | hospital | 2 |
| health studios & gym | 12 | | nursing home gt 6 | 2 |
| workshop commercial | 11 | | sfpd or sffd station | 2 |
| theater | 9 | | nursery(floral) | 2 |
| auto repairs | 8 | | sign | 2 |
| public assmbly other | 7 | | antenna | 1 |
| parking lot | 7 | | phone xchnge/equip | 1 |
| sound studio | 6 | | dance hall | 1 |
| warehouse, furniture | 6 | | library | 1 |
| dry cleaners | 6 | | nursing home non amb | 1 |
| social care facility | 6 | | fence/retaining wall | 1 |
| sewage plant | 5 | | | |

Residential and non-building uses to exclude for this subscriber, with counts:

| Use | Rows | Note |
| --- | --- | --- |
| 1 family dwelling | 3,451 | Kickoff list |
| apartments | 2,394 | Kickoff list |
| 2 family dwelling | 2,293 | Kickoff list |
| residential hotel | 41 | Kickoff list |
| misc group residns. | 25 | Kickoff list |
| artist live/work | 22 | Kickoff list |
| vacant lot | 38 | **Not in the kickoff list.** No building, no electrical scope. |
| storage shed | 10 | **Not in the kickoff list.** Below any commercial threshold. |
| accessory cottage | 5 | **Not in the kickoff list.** Residential accessory structure. |
| *(absent)* | 201 | 1.85%. Maps to `null` + `unknown`, not to "residential". |

The three buckets partition the extract exactly: 8,279 rows excluded, 2,400 rows commercial across the 55
uses tabulated above, 201 rows unknown. Sum 10,880.

### 2.6 Flags

| Source field | Normalized field | Type | Populated | Notes |
| --- | --- | --- | --- | --- |
| `adu` | `flags.adu` | boolean | 100.00% | `N` 10,826, `Y` 54. The only flag that is explicitly `N` rather than absent. |
| `application_submission_method` | `submissionMethod` | string | 100.00% | `in-house` 10,011, `website` 867, `epr website` 2. |
| `structural_notification` | `flags.structuralNotification` | boolean | 3.01% | `Y` only, 327 rows. |
| `fire_only_permit` | `flags.fireOnly` | boolean | 2.66% | `Y` only, 289 rows. A fire-only permit is a hard disqualifier for an electrical subscriber. |
| `reroof` | `flags.reroof` | boolean | 12.88% | `Y` only, 1,401 rows. Roofing scope, near-zero electrical content. |
| `site_permit` | `flags.sitePermit` | boolean | 0.24% | `Y` only, 26 rows. |
| `voluntary_soft_story_retrofit` | `flags.softStoryRetrofit` | boolean | **0.00%** | **Key never appears in the extract.** Declared by the dataset, absent from all 10,880 rows. See correction C2. |
| `tidf_compliance` | `flags.tidfCompliance` | boolean | **0.00%** | **Key never appears in the extract.** Same. |

Every `Y`-only flag follows the same rule: present means true, absent means false, and absent is genuinely
false rather than unknown, because the agency emits the key only in the affirmative case. `adu` is the
exception and emits both values.

---

## 3. Contacts: field mapping

Legend as above, share of 22,148 rows.

| Source field | Normalized field | Type | Populated | Notes |
| --- | --- | --- | --- | --- |
| `id` | `permitGroupId` | string | 100.00% | **Not a row primary key.** 10,013 distinct values across 22,148 rows. Each value maps to exactly one `permit_number` (verified: every `id` resolves to exactly 1 distinct permit number). It is a per-permit group id. See correction C3. |
| `pts_agent_id` | `agentId` | string | 100.00% | **22,148 distinct across 22,148 rows. This is the row key.** Use it, not `id`. |
| `permit_number` | `permitNumber` | string | 100.00% | The join key. Zero orphan rows: every contact resolves to a permit in the extract. |
| `role` | `role` | string | 100.00% | 11 distinct values, complete table below. |
| `is_applicant` | `isApplicant` | boolean | 100.00% | `N` 13,058, `Y` 9,090. Both values always present, so no absent-means-false ambiguity. |
| `first_name` | `person.firstName` | string \| null | 97.59% | |
| `last_name` | `person.lastName` | string \| null | 94.80% | |
| `firm_name` | `firm.name` | string \| null | 71.44% | 4,549 distinct raw strings. See correction C8 on spelling variants. |
| `license1` | `license.primary` | string \| null | 63.47% | Headline rate is misleading. Role-conditional rates below. |
| `license2` | `license.secondary` | string \| null | **0.01%** | **2 rows in 22,148**, and one of the two is an email fragment (`WDHENDERSON@GMA`) rather than a license. Unusable. Do not map it into a `Finding`. |
| `sf_business_license_number` | `license.sfBusiness` | string \| null | 40.78% | 9,031 rows, which is exactly the contractor row count. See correction C6. |
| `agent_address` | `person.address` | string \| null | 22.20% | The individual's address. |
| `agent_address2` | `person.address2` | string \| null | 1.49% | |
| `city` | `person.city` | string \| null | 22.55% | |
| `state` | `person.state` | string \| null | 22.07% | |
| `agent_zipcode` | `person.zipcode` | string \| null | 21.45% | Mostly `99999` shape; a handful of malformed values (`A99999`, a 10-digit run). Validate, do not trust. |
| `firm_address` | `firm.address` | string \| null | 63.24% | |
| `firm_city` | `firm.city` | string \| null | 63.22% | |
| `firm_state` | `firm.state` | string \| null | 63.31% | Includes at least one truncated value (`C` for `CA`). |
| `firm_zipcode` | `firm.zipcode` | string \| null | 62.68% | **9,334 rows use ZIP+4 with a `-0000` filler** (the hero's GC is `94111-0000`). Truncate to five digits before comparing against a territory allowlist. 8 rows carry a Canadian postal code. |
| `from_date` | `activeFrom` | string \| null | 100.00% | Date this party joined the permit. Meaningful: see the hero trace. |
| `to_date` | `activeTo` | string \| null | 0.76% | 169 rows. Absent means still active. |
| `data_as_of` | `provenance.dataAsOf` | string \| null | 100.00% | |
| `data_loaded_at` | `provenance.dataLoadedAt` | string \| null | 100.00% | |

All 24 declared contact columns appear in the extract, unlike the permits dataset.

### 3.1 Roles, and how much identity each role carries

This table is the single most useful thing in the document for contact-path reasoning. The 63.47% headline
`license1` rate hides the fact that the rate is essentially binary by role.

| Role | Rows | Share | `license1` | `sf_business_license_number` | `firm_name` |
| --- | --- | --- | --- | --- | --- |
| contractor | 9,031 | 40.78% | **100.0%** | **100.0%** | **100.0%** |
| authorized agent-others | 4,729 | 21.35% | 4.9% | 0.0% | 38.3% |
| engineer | 2,252 | 10.17% | 98.5% | 0.0% | 72.0% |
| architect | 2,178 | 9.83% | 97.0% | 0.0% | 73.5% |
| payor | 1,271 | 5.74% | 14.8% | 0.0% | 35.0% |
| project contact | 1,088 | 4.91% | 3.4% | 0.0% | 30.2% |
| designer | 931 | 4.20% | 24.5% | 0.0% | 62.0% |
| pmt consultant/expediter | 493 | 2.23% | 0.8% | 0.0% | 59.4% |
| lessee | 168 | 0.76% | 3.0% | 0.0% | 67.3% |
| attorney | 4 | 0.02% | 0.0% | 0.0% | 50.0% |
| subcontractor | 3 | 0.01% | 100.0% | 0.0% | 0.0% |

Read the first row carefully. **Every contractor row in the extract carries both a license number and an SF
business license number, and names a firm.** That is 9,031 of 9,031, with no exceptions. Contractor identity
is therefore `verified` from the permit record alone, with no external lookup required. This is the finding
that makes the CSLB blocker (C9) survivable.

Note the `subcontractor` role exists but is used on 3 rows out of 22,148. Subcontractors are essentially never
listed on an SF building permit. That absence is the product thesis: the electrical sub is not on the record
because the sub has not been chosen yet.

### 3.2 License number formats by role

Formats are role-diagnostic and worth encoding, because they tell you what kind of party you are looking at
even when `firm_name` is absent.

| Role | Dominant shapes | Reading |
| --- | --- | --- |
| contractor | `999999` (4,225), `9999999` (3,491) | Purely numeric. This is a CSLB contractor license number. |
| engineer | `A99999` (1,225), `A9999` (388), numeric (251) | Letter-prefixed California PE number. |
| architect | `C99999` (1,643), `C-99999` (358) | `C` prefix dominates, 2,016 of 2,178. |

Engineer license prefixes, which identify the discipline:

| Prefix | Rows | Discipline |
| --- | --- | --- |
| `C` | 837 | Civil |
| `S` / `SE` | 429 | Structural |
| `M` | 304 | Mechanical |
| `E` | 278 | **Electrical** |
| *(numeric)* | 354 | Unprefixed, discipline not determinable from the number |

The `E` prefix matters directly. It tells you whether a permit already has an electrical engineer of record,
which is a different question from whether it has an electrical contractor. Prefix matching must be
case-insensitive: 13 rows use lowercase prefixes (`c`, `s`, `m`, `e`).

---

## 4. The join

**Key:** `permits.permit_number` to `contacts.permit_number`. String equality, no normalization needed. Both
sides are 100.00% populated.

Measured coverage:

| Measure | Value |
| --- | --- |
| Distinct `permit_number` in permits | 10,049 |
| Distinct `permit_number` in contacts | 10,013 |
| Distinct permits with at least one contact | 10,013 (**99.64%**) |
| Permit rows (undeduplicated) with at least one contact | 10,841 of 10,880 (99.64%) |
| Contact rows whose `permit_number` is absent from permits | **0** |
| Contacts per permit | min 0, median 2, mean 2.20, max 9 |

The join is reliable in both directions. There are no orphan contacts, and only 36 distinct permits have no
contact row at all. A permit with zero contacts is a real observation, not a fetch failure, and should produce
`gc.firm_name` = `null` with evidence `unknown` rather than being silently dropped.

`contacts.id` is tempting as a join key because it is 1:1 with `permit_number`, but it is a Socrata-side group
id with no meaning to the agency. Join on `permit_number`. It is the field the agency itself documents as the
relationship, and it is the field a human can verify against the public permit record.

---

## 5. Corrections to the kickoff assumptions

Each item states what the kickoff assumed, what the data shows, and what the code must do. Items C1 through C4
change code behaviour and are the reason this document is a P0 blocker.

### C1. `permit_number` is not unique. The primary key in the migration is wrong for this data.

The kickoff lists `permit_number` as `(PK, join key)`. Measured: 10,880 rows carry only 10,049 distinct permit
numbers. 726 permit numbers occupy more than one row (647 groups of 2, 59 of 3, 18 of 4, 1 of 5, 1 of 9), for
831 rows beyond the first.

The duplicates are not ingestion noise. Only one duplicate pair in the entire extract is byte-identical. The
fields that differ within a group, in frequency order, are `record_id` (830), `primary_address_flag` (758),
`street_number` (716), `location` (218), `lot` (139), `unit` (139). A worked example, permit `202304296759`:

```
street_number:         "272"            vs  "274"
primary_address_flag:  "Y"              vs  (absent)
record_id:             "1667426161245"  vs  "1746112364396"
```

That is one permit covering two adjacent addresses, published as one row per address.

**Contract mismatch.** `supabase/migrations/0001_init.sql` declares `permit_records.permit_number text primary
key`. Upserting the extract as-is will silently collapse 831 rows and, worse, the surviving row will be
whichever one happened to be written last, which may be the non-primary address.

**Required behaviour.** Deduplicate before insert, deterministically: group by `permit_number`, select the row
where `primary_address_flag === 'Y'`, and fall back to the first row in source order when no row is flagged.
This is safe: of the 726 duplicate groups, 725 have exactly one flagged row and 1 has more than one; zero
groups have none. Retain the discarded addresses in `normalized.alternateAddresses` so the fact that the
project spans several addresses is preserved rather than lost. Keep the primary key as `permit_number`; the
dedupe belongs in the normalizer, which is pure and testable, not in the database.

### C2. Two declared columns never appear. Socrata JSON is sparse.

The dataset declares 53 columns. **51 appear in the extract.** `voluntary_soft_story_retrofit` and
`tidf_compliance` are present in zero of 10,880 rows.

This is not a truncated download; it is how Socrata serializes JSON. Empty values are omitted from the object
entirely rather than emitted as `null` or `""`. A normalizer that assumes key presence will produce
`undefined` rather than a validation error, which under `noUncheckedIndexedAccess` is exactly the failure mode
TypeScript is configured to catch. Every field access must go through an optional-aware coercion helper, and
the Zod schema for a raw permit must mark all 51 fields optional except the ones measured at 100.00%.

The practical consequence: absent means absent. `first_construction_document_date` at 1 row in 10,880 is in
the same category. Do not build a signal on a field the agency does not actually populate.

### C3. `contacts.id` is not a row primary key. `pts_agent_id` is.

The kickoff lists `id` first, in the position a primary key normally occupies. Measured: 10,013 distinct values
across 22,148 rows, with 6,912 values appearing more than once. Every `id` maps to exactly one `permit_number`,
so it functions as a per-permit group id.

`pts_agent_id` has 22,148 distinct values across 22,148 rows. It is the row key. There are zero byte-identical
duplicate contact rows.

Keying a contacts table or an upsert on `id` would discard 12,135 rows.

### C4. Dates carry no timezone. The core schema will reject them.

Every date field on both datasets, on every populated row, matches `YYYY-MM-DDTHH:MM:SS.mmm` with no `Z` and
no offset. Zero rows carry a timezone designator.

**Contract mismatch.** `lib/domain/schemas/core.ts` validates timestamps with `z.string().datetime({ offset:
true })` on `provenanceSchema.retrievedAt`, `findingSchema.observedAt`, `snapshotDeltaSchema.observedAt`, and
`agentEventSchema.ts`. A raw DataSF timestamp passed into any of those will fail validation.

These are San Francisco wall-clock times (`America/Los_Angeles`). The normalizer must attach the offset before
the value crosses into a `Finding` or a `Provenance`. Because normalizer modules are pure and may not read the
clock, the conversion has to be a pure function of the timestamp string plus the fixed source timezone, and it
must handle the DST boundary explicitly rather than hardcoding `-08:00`. The extract spans February to August
2026, so it crosses the boundary in both directions and a hardcoded offset would be wrong for most of it.

### C5. Contacts do carry license numbers. The assumption held, and is now measured.

The kickoff assumed contact rows would carry license numbers. Confirmed, with the important refinement that
the aggregate rate understates the useful rate:

- `license1`: 14,058 of 22,148 rows, **63.47%** aggregate. But **100.0% of the 9,031 contractor rows**, 98.5%
  of engineers, 97.0% of architects. The aggregate is dragged down by roles that have no license to give
  (`authorized agent-others` at 4.9%, `project contact` at 3.4%, `pmt consultant/expediter` at 0.8%).
- `license2`: **2 rows, 0.01%.** One of the two is an email fragment. Treat this field as absent.
- `sf_business_license_number`: 9,031 rows, **40.78%** aggregate, and **100.0% of contractor rows and 0.0% of
  every other role**. It is a contractor-only field, not a sparse general field.

The operational conclusion: for the party that matters to this product, the general contractor, firm name,
CSLB license number, and SF business license number are all present on every single record. Contractor
identity is `verified` straight from the permit with no enrichment call.

### C6. `sf_business_license_number` is contractor-conditional, not sparse.

Stated separately from C5 because it changes how the field should be modelled. 9,031 contractor rows, 9,031
populated `sf_business_license_number` values, and zero populated values on any other role. This is a
role-gated field with perfect coverage inside its gate. A `Finding` for it should only be emitted for
contractor rows; emitting `unknown` for an architect is noise, not a visible unknown, because the field does
not apply.

### C7. `permit_type` 9 is the solar bucket and it has no `permit_type_definition`.

198 rows carry `permit_type` `9` and no `permit_type_definition`. All 198 have a description, and the
descriptions are solar PV installations (a sample: `solar permit: installing 27 solar pv modules, 405 watts per
module...`). 150 of the 198 also carry an `existing_use`.

**Solar PV is electrical work**, and this subscriber is an electrical contractor, so a shortlist filter written
as "require a `permit_type_definition` in an allowlist" would discard the whole bucket on a missing label
rather than on the merits. Filter on `permit_type` codes, or explicitly admit the null-definition case, rather
than requiring the definition string to be present.

Measured impact on this extract, stated so the fix is not oversold: admitting the definition-less rows carries
172 extra permits past the type gate (6,707 rather than 6,535), and all 172 are then excluded at the commercial
use gate. 132 have `existing_use` `2 family dwelling` and 40 have no use at all; **none is commercial**. The
final shortlist is 694 either way. This is residential rooftop solar. The permissive rule is correct in
principle and inert in this particular six month window.

### C8. Firm names are free text with spelling variants. Exact-string matching over-counts firms.

`firm_name` has 4,549 distinct raw values, falling to 4,423 after lowercasing and stripping punctuation. One
law firm appears under eight spellings in this extract alone:

```
Reuben, Junius & Rose, Llp.     Reuben, Junius & Rose Llp
Reuben, Junius & Rose Llp.      Reuben, Junius & Rose,Llp
Reuben Junuis & Rose Llp        Reuben, Junius & Rose. Llp
Reuben, Juniis & Rose Llp       Reuben, Junius & Rose
```

Two of those are outright misspellings of the firm's own name (`Junuis`, `Juniis`), entered by different
applicants. Firm identity must be resolved on `license1` where one exists (which for contractors is always),
and firm name treated as a display label rather than a key. Where a name must be matched, normalize case and
punctuation first, and label the result `inferred` rather than `verified`.

`firm_zipcode` needs its own normalization: 9,334 of 13,881 populated values use ZIP+4 with a `-0000` filler,
so `94111-0000` and `94111` are the same place. Truncate to five digits before any territory comparison.
`firm_state` includes at least one truncated value (`C` for `CA`), and 8 rows carry Canadian postal codes.

### C9. CSLB bulk download was not obtainable non-interactively.

The California State License Board's contractor list download is served behind an ASP.NET WebForms page that
requires a `__VIEWSTATE` / `__EVENTVALIDATION` postback to reach the file. The tokens are generated per session
and embedded in the page, so the download cannot be fetched with a plain HTTP request and could not be
obtained non-interactively.

**Impact: low, and this is why C5 matters.** The purpose of the CSLB list was to establish contractor identity
and license validity. The permit contacts dataset already supplies firm name, CSLB license number, and SF
business license number on 100.0% of contractor rows, from a first-party agency source. That is a `verified`
label without CSLB.

What CSLB would have added, and what stays `unknown` without it: license *status* (active, expired, suspended),
classification codes (whether a contractor holds a `C-10` electrical classification), bond and workers'
compensation status, and expiry dates. Those facts must be recorded as `value: null`, `evidence: 'unknown'`.
They must not be inferred from the license number's existence. A license number on a permit proves the number
was entered; it does not prove the license is currently active.

Any capability that would depend on a CSLB lookup must be guarded with `hasCapability()` from
`lib/config/deployment-env.ts` and return a typed skipped result, per the output discipline. It must not crash
and must not fabricate a status.

### C10. Dataset selection: `i98e-djp9` over `p4e4-a5a7`.

The kickoff required picking exactly one permits dataset after live inspection rather than assuming, and
recorded the outcome: `i98e-djp9` is the full Building Permits dataset at 53 columns, and it carries
`approved_date` and `reroof`, which the `p4e4-a5a7` variant (51 columns) lacks.

Both retained fields earn their place here. `approved_date` is populated on 76.40% of rows and is a direct
timing signal, distinct from `issued_date`. `reroof` flags 1,401 rows (12.88%) whose scope is roofing and
therefore carries almost no electrical content, which makes it a cheap negative filter for this subscriber.
Losing either would degrade the product.

Evidence discipline on this item: the choice and its reasoning are recorded from the kickoff's live inspection,
and `manifest.json` independently confirms `i98e-djp9` is the dataset actually retrieved. The 53-versus-51
column comparison against `p4e4-a5a7` was **not** re-verified offline, because the extract on disk contains
only the chosen dataset. Label that specific comparison `corroborated`, not `verified`, until someone re-runs
the live inspection. What is `verified` from the extract alone: `i98e-djp9` does carry `approved_date` and
`reroof`, and the dataset declares 53 columns of which 51 appear (see C2).

### C11. `existing_use` alone does not establish that a project is commercial.

Found while validating the hero against higher-valued alternatives, and it changes the shortlist filter.

The kickoff frames the commercial / residential split as a property of `existing_use`. It is not. A conversion
permit is commercial today and residential when finished, and `existing_use` reports only the first half.

Measured: **30 permits convert commercial to residential** and 15 convert residential to commercial. The two
largest records that survive the full shortlist funnel are both conversions:

| Permit | Valuation | `existing_use` | `proposed_use` | `proposed_units` | `proposed_occupancy` |
| --- | --- | --- | --- | --- | --- |
| 202606123167 | $90,000,000 | office | apartments | `92.0` | `R-2,A-3,S-2` |
| 202606123166 | $35,000,000 | office | apartments | `44.0` | `R-2,A-3,S-2` |

Nine such records clear every gate and sit inside the 694-record shortlist, which is 1.3% of it, weighted
heavily toward the top by value. An electrical subscriber who wants commercial work would reject all nine.
The full list is tabulated in `docs/hero-permits.md` section 4.1.

**Required behaviour.** Gate on both fields: exclude when `existing_use` is residential **or** `proposed_use`
is residential. Do not exclude on an absent `proposed_use`, which is 2.92% of rows: absent is `unknown`, not
residential, and discarding 2.92% of the pipeline on a missing field costs more than it saves.
`proposed_occupancy` (`R-` prefixes) and `proposed_units` corroborate the same signal and are worth carrying
into the `Finding` set, but `proposed_use` is the field to gate on because it is the more populated of the
three and it is directly comparable to the exclusion list already in use.

### C12. The permit number prefix is not a reliable date.

`permit_number` opens with what looks like a `YYYYMMDD` stamp, which invites using it as a date. It disagrees
with `permit_creation_date` on 732 of 10,880 rows (6.7%) and with `filed_date` on 576 of 10,681 (5.4%).

Permit `202512292849` is the clearest case: the prefix reads 2025-12-29, `permit_creation_date` is
`2025-12-29T09:13:32.000`, and `filed_date` is `2026-02-20T00:00:00.000`, nearly two months later. The prefix
tracks application creation, not filing, and even then not always.

Parse dates from the date fields. Treat `permit_number` as an opaque identifier string.

---

## 6. Summary of what changed for the code

| Correction | Module affected | Change required |
| --- | --- | --- |
| C1 | permit normalizer, ingestion | Deduplicate by `permit_number` on `primary_address_flag`; keep alternates |
| C2 | raw permit Zod schema | All 51 fields optional except the measured-100% set; optional-aware coercion throughout |
| C3 | contacts ingestion | Key on `pts_agent_id`, never on `id` |
| C4 | timestamp normalizer | Attach `America/Los_Angeles` offset, DST-aware, pure, before Zod validation |
| C5, C6 | enrichment, Findings | Contractor identity is `verified` from the permit; emit `sf_business_license_number` only for contractor rows |
| C7 | shortlist filter | Do not require `permit_type_definition` to be present; solar is `permit_type` 9 |
| C8 | firm resolution | Key on `license1`; normalize case, punctuation, and ZIP+4 before comparison; label name matches `inferred` |
| C9 | CSLB capability | Guard with `hasCapability()`; license status stays `null` + `unknown` |
| C10 | source registry | `datasetId: 'i98e-djp9'`, endpoint as recorded above |
| C11 | shortlist filter | Gate on `existing_use` **and** `proposed_use`; absent `proposed_use` does not exclude |
| C12 | any date handling | Never parse a date out of `permit_number`; use the date fields |

The four that will break the build or silently corrupt data if ignored are **C1** (primary key collapses 831
rows), **C2** (absent keys become `undefined` under `noUncheckedIndexedAccess`), **C3** (wrong contacts key
discards 12,135 rows), and **C4** (raw timestamps fail Zod validation in `core.ts`). C11 does not break
anything; it silently admits wrong leads, including the two largest in the shortlist.
