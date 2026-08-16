# Hero permit and backups

What this document is: the specific real records the demo runs on, why each was chosen, and a hand trace of
each one through every deterministic gate with the actual field values quoted. A teammate or a judge should be
able to read this cold and then verify every claim in it against `data/permits.json` in under a minute using
section 7.

Everything here is quoted from the committed extract. No record was constructed, edited, or invented
(CLAUDE.md hard rule #5: real records only). Where a field is absent from the record, this document says
absent rather than filling it in.

| | |
| --- | --- |
| Source | DataSF Building Permits `i98e-djp9`, Contacts `3pee-9qhc` |
| Extract retrieved | `2026-08-15T16:47:00.415Z` |
| Subscriber | Mike's Commercial Electric, trade electrical, San Francisco, minimum project value $100,000 |

---

## 1. The hero: permit 202603238106

**555 California St, Financial District/South Beach. Office tenant improvement on floor 31 of a 52 story
tower. $8,285,917. Issued 2026-04-10. General contractor on the record, no electrical contractor.**

### 1.1 The record, verbatim

One row in the extract for this permit number, so no deduplication is needed here (contrast C1 in
`docs/mappings.md`).

```json
{
  "permit_number": "202603238106",
  "permit_type": "8",
  "permit_type_definition": "otc alterations permit",
  "permit_creation_date": "2026-03-23T00:00:00.000",
  "block": "0259",
  "lot": "026",
  "street_number": "555",
  "street_name": "California",
  "street_suffix": "St",
  "unit": "0",
  "description": "31/fl- remodel (e) office space, propsed ti work entails (n) non bearing partitiosn, millwork, ceiling system with (n) lighting, power and communication fixtures and furniture systems. floor and wall finishes",
  "status": "issued",
  "status_date": "2026-04-10T15:03:06.000",
  "filed_date": "2026-03-23T14:30:55.000",
  "issued_date": "2026-04-10T15:03:06.000",
  "approved_date": "2026-04-10T15:03:06.000",
  "number_of_existing_stories": "52",
  "number_of_proposed_stories": "52",
  "estimated_cost": "8285917.0",
  "revised_cost": "8285917.0",
  "existing_use": "office",
  "proposed_use": "office",
  "plansets": "2",
  "existing_occupancy": "B",
  "proposed_occupancy": "B",
  "existing_construction_type": "1",
  "existing_construction_type_description": "constr type 1",
  "proposed_construction_type": "1",
  "proposed_construction_type_description": "constr type 1",
  "last_permit_activity_date": "2026-04-10T14:47:46.000",
  "application_submission_method": "in-house",
  "adu": "N",
  "primary_address_flag": "Y",
  "supervisor_district": "3",
  "neighborhoods_analysis_boundaries": "Financial District/South Beach",
  "zipcode": "94104",
  "location": { "type": "Point", "coordinates": [-122.403518141, 37.792579585] },
  "point_source": "eas_address_point",
  "record_id": "1745632298587",
  "data_as_of": "2026-04-12T01:05:02.000",
  "data_loaded_at": "2026-04-12T05:30:44.519"
}
```

Fields absent from this record, out of the 51 that appear anywhere in the extract. These are the honest
`unknown`s for this permit and the UI must keep them visible:

`completed_date`, `existing_units`, `fire_only_permit`, `first_construction_document_date`, `proposed_units`,
`reroof`, `site_permit`, `street_number_suffix`, `structural_notification`, `unit_suffix`

Note `unit: "0"`, which is the agency's placeholder for no unit rather than a unit named zero. Also note that
absence of `fire_only_permit` and `reroof` is meaningful here: both are `Y`-only flags, so absent means the
project is genuinely not a fire-only permit and not a reroof. Both would be disqualifiers.

### 1.2 The contact roster, verbatim

Five contact rows, all sharing group id `1216446`.

| Role | Name | Firm | `license1` | SF business licence | `from_date` | Applicant |
| --- | --- | --- | --- | --- | --- | --- |
| contractor | Fabian Valdiosera | Skyline Construction | `727637` | `1109804` | 2026-04-03 | N |
| authorized agent-others | Michael Verity | Reuben, Junius & Rose, Llp. | *(absent)* | *(absent)* | 2026-03-23 | **Y** |
| engineer | Benjamin Noggle | Pae Engineers | `E19515` | *(absent)* | 2026-03-23 | N |
| engineer | James Bradshaw | Pae | `M34110` | *(absent)* | 2026-03-23 | N |
| architect | Mark Walsh | *(absent)* | `C36025` | *(absent)* | 2026-03-23 | N |

Details worth carrying into enrichment:

- **Skyline Construction** is the general contractor. `firm_address` `505 Sansome St. 7th Floor`, `firm_city`
  `San Francisco`, `firm_zipcode` `94111-0000`. That trailing `-0000` is the ZIP+4 filler described in
  correction C8; normalize to `94111` before any territory comparison. `pts_agent_id` `2548287`.
  Firm name, CSLB number, and SF business licence are all present, so GC identity is `verified` with no
  external lookup.
- **Skyline's footprint in the extract**: 95 contact rows across 85 distinct permits, 62 of them as
  contractor, always under CSLB `727637` and SF business licence `1109804`. This is a real, active,
  high-volume San Francisco general contractor, not a one-off name.
- **Mark Walsh's row has no `firm_name`** but does carry `firm_address` `410 N Michigan` and `firm_city` `Sf`.
  The firm is genuinely unknown from this record. It stays `null` with evidence `unknown`. Do not infer a
  firm name from the address.
- **PAE holds `E19515`.** The `E` prefix is the electrical discipline (278 engineer rows in the extract carry
  it). PAE is therefore the electrical **engineer** of record. `M34110` on the second PAE row is mechanical.

### 1.3 The `from_date` detail that makes the story

The contractor row's `from_date` is **2026-04-03**. The permit was filed **2026-03-23** and issued
**2026-04-10**. Every other party joined on 2026-03-23, the filing date.

So the sequence on this record is: architect, engineers, and the applicant's law firm file on 23 March; the
general contractor is added on 3 April, eleven days later; the permit issues on 10 April. That is the general
contractor being selected and added to the permit between filing and issuance. It is the buyout window,
visible in the data.

### 1.4 Why this record was chosen

1. **It clears every deterministic gate with room to spare.** No borderline value anywhere. Traced in
   section 2.
2. **The scope is explicitly electrical, in the applicant's own words.** The description names
   `(n) lighting, power and communication fixtures`. That is lighting, power distribution, and low-voltage
   communications, which is the whole of a commercial electrical TI scope. No interpretation is needed to see
   it, so the deterministic layer and the interpretation layer agree.
3. **$8,285,917 is 83 times the subscriber's $100,000 floor** and sits in the top 10 of all 694 records that
   survive the funnel. `revised_cost` and `estimated_cost` are equal, so valuation is unambiguous and the
   record does not depend on the `max()` rule to qualify. (The 100 Stockton backup exercises that rule
   instead; see section 3.1.)
4. **There is a named, licensed, local general contractor to call.** Many qualifying permits have no
   contractor row at all (148 of the 694 survivors). Here the path in is a specific firm with a verified
   licence number and a San Francisco address.
5. **There is no electrical contractor on the permit.** Verified: zero of the five contact rows mention
   "electric" in any field, and no row has `role: "contractor"` other than Skyline. This absence is the
   opportunity.
6. **The work is forming, not finished.** `status` is `issued` and `completed_date` is absent. Relative to
   the record's own `data_as_of` of 2026-04-12, the permit had issued 1.4 days earlier. The job is live.

### 1.5 The pitch beat this record supports

The chain of reasoning, each link resting on a quoted field:

> An $8.3M office fit-out on the 31st floor of 555 California is permitted and issued. The permit explicitly
> covers new lighting, power, and communications. PAE has stamped the electrical design under licence E19515,
> so the drawings exist. Skyline Construction was added as general contractor on 3 April and the permit issued
> on 10 April. No electrical contractor is named anywhere on the record. Skyline is buying out subs right now.

The outreach is to **Skyline Construction, the general contractor**, not to the building owner and not to PAE.
Skyline is the party that awards the electrical subcontract, is licensed and locatable (CSLB 727637, 505
Sansome St), and has just been appointed, which is precisely when subcontractor packages go out.

Two points of discipline on the customer-facing copy generated from this record (CLAUDE.md hard rule #9):

- The pitch is the contractor's problem and outcome, which is a named live job with an unfilled electrical
  package. It is never how the record was found. The words AI, agent, autonomous, LLM, and automated do not
  appear in anything the subscriber sees.
- The claim is "no electrical contractor is named on the permit", which is exactly what the data shows. It is
  not "the electrical work is unawarded", which the data does not show. The sub may already be chosen and
  simply not filed. Keep the claim inside the evidence.

### 1.6 What stays unknown on this record

Recorded here so the UI can render them as visible unknowns rather than gaps:

| Fact | Value | Evidence | Why |
| --- | --- | --- | --- |
| Skyline CSLB licence status | `null` | `unknown` | Licence number is verified; status was not obtainable (correction C9, CSLB bulk download behind a VIEWSTATE postback) |
| Skyline classification (C-10 etc.) | `null` | `unknown` | Same |
| Electrical subcontractor | `null` | `unknown` | Not present on the permit. Absence of a record is not a record of absence. |
| Architect firm name | `null` | `unknown` | `firm_name` absent on the Mark Walsh row |
| Project completion date | `null` | `unknown` | `completed_date` absent, consistent with an open permit |
| Direct phone or email for Skyline | `null` | `unknown` | The contacts dataset carries postal addresses only, no phone or email columns |

---

## 2. Hero trace through the deterministic gates

Each gate applied in order, with the hero's actual field value quoted and the surviving population after that
gate. Population figures are over the 10,049 distinct permit numbers left after the C1 deduplication.

The gate set below is the trace used to validate this record. The binding filter contract lives in the
shortlist module; where this trace makes a choice the kickoff did not specify, it is flagged.

| # | Gate | Rule | Hero's value | Pass | Survivors |
| --- | --- | --- | --- | --- | --- |
| 0 | Deduplicate | Group by `permit_number`, take `primary_address_flag === 'Y'` | `primary_address_flag: "Y"`, single row | yes | 10,049 |
| 1 | Geography | `zipcode` present and resolvable to the SF territory | `zipcode: "94104"`, `supervisor_district: "3"`, `neighborhoods_analysis_boundaries: "Financial District/South Beach"` | yes | 10,039 |
| 2 | Status | `status` in `{filed, issued, approved, reinstated}`, so the permit is live | `status: "issued"` | yes | 6,898 |
| 3 | Permit type | Exclude signage, demolition, and excavation types, which carry no electrical scope | `permit_type: "8"`, `permit_type_definition: "otc alterations permit"` | yes | 6,707 |
| 4 | Commercial use | `existing_use` present and not in the residential exclusion set | `existing_use: "office"` | yes | 1,682 |
| 5 | Cost floor | `max(revised_cost, estimated_cost) >= 100000` | `max(8285917.0, 8285917.0) = 8,285,917` | yes | 694 |

**The hero clears all six gates.** Verified programmatically, not by eye.

Notes on the gate definitions:

- **Gate 1** drops the 10 permits with no `zipcode`. Every zipcode in the extract begins `941`, so no
  out-of-territory records exist in this window and the gate is currently a completeness check rather than a
  geographic one. It must still be written as a real allowlist check, because a future extract is not bound by
  this window's behaviour.
- **Gate 2** excludes `complete` (3,266 rows), which is the single largest reduction. A completed job has no
  subcontract left to award. It also excludes `cancelled`, `withdrawn`, `suspend`, `denied`, and `expired`.
- **Gate 3** excludes `sign - erect`, `wall or painted sign`, `demolitions`, and
  `grade or quarry or fill or excavate`. It deliberately does **not** require `permit_type_definition` to be
  present, because the 198 rows with no definition are the solar PV bucket (`permit_type` `9`), which is
  electrical work this subscriber wants. See correction C7.
  Worth being precise about what that choice buys in this extract: admitting the definition-less rows carries
  172 extra permits past gate 3 (6,707 rather than 6,535), and **every one of them is filtered out at gate 4**.
  Of the 172, 132 have `existing_use` `2 family dwelling` and 40 have no use at all, so zero are commercial.
  They are residential rooftop solar installations. The final shortlist is 694 either way. The permissive rule
  is still the right one, because a commercial solar or battery job in a future window would otherwise be
  dropped for a missing label rather than on its merits, but it changes nothing in this six month window and
  this document should not imply otherwise.
- **Gate 4** uses the residential exclusion set. Beyond the six values the kickoff listed, this trace also
  excludes `vacant lot` (38), `storage shed` (10), and `accessory cottage` (5), which are not residential but
  have no commercial electrical scope. Flagged as a trace decision, recorded in `docs/mappings.md` section 2.5.
  Rows with an absent `existing_use` (201) fail this gate because the fact is unknown, not because it is
  residential. That is the conservative direction: an unknown never qualifies a lead.
  **This gate as traced is incomplete.** It reads `existing_use` only, which lets commercial-to-residential
  conversions through. See section 4.1 and correction C11. The hero passes either version of the gate, so the
  trace above stands, but the shortlist module must implement the corrected form.
- **Gate 5** uses `max()` rather than preferring `revised_cost`, because 654 rows carry `revised_cost` `"0.0"`
  alongside a positive `estimated_cost`. See correction in `docs/mappings.md` section 2.4.

### 2.1 What the surviving 694 look like

Context for how selective the funnel is and where the hero sits inside it:

| Measure | Value |
| --- | --- |
| Survivors after all gates | 694 of 10,049 (6.9%) |
| Survivors naming a contractor | 546 (78.7%) |
| Survivors with no contractor row at all | 148 (21.3%) |
| Survivors already naming an electrical contractor | **7 (1.0%)** |
| Survivors whose description contains an electrical scope keyword | 380 (54.8%) |
| Hero's rank by valuation | 9th of 694 |

That 1.0% figure is the product thesis stated numerically. Of every qualifying commercial project in San
Francisco over $100,000 in this six month window, 99% do not have an electrical contractor named on the
permit. The `subcontractor` role exists in the dataset and is used on 3 rows out of 22,148, because SF permits
simply do not list subs. The electrical package is open on almost all of them.

---

## 3. Backup candidates

Three alternates, in the order they should be reached for. Each traced through the same six gates. All three
clear all six, verified programmatically.

### 3.1 202607295760, 100 Stockton St

**$14,150,000 medical clinic tenant improvement, filed 2026-07-29, no general contractor yet.**

| Field | Value |
| --- | --- |
| Address | 100 Stockton St, zip `94108`, district `3`, Financial District/South Beach |
| Block / lot | `0313` / `017` |
| Status | `filed` (`status_date` `2026-07-29T14:04:24.000`, no `issued_date`, no `approved_date`) |
| Type | `permit_type` `8`, `otc alterations permit` |
| Use | `clinics-medic/dental`, occupancy `M,B`, 8 stories, construction type 1 |
| `estimated_cost` | `"14150000.0"` |
| `revised_cost` | **`"0.0"`** |
| Valuation | `max(0, 14150000) = 14,150,000` |
| `record_id` | `1754129521214` |
| Description | `1st and 3rd floor - tenant improvement at ground and 3rd floors including demo and construction of interior partitions and doors, electrical, hvac and plumbing.` |

Gate trace: 0 primary row, single row for this permit number. 1 `zipcode: "94108"` passes. 2 `status: "filed"`
passes. 3 `otc alterations permit` passes. 4 `clinics-medic/dental` is commercial, passes. 5 valuation
$14,150,000 passes. **Clears all six.**

Contacts, five rows, group id `1224300`:

| Role | Name | Firm | `license1` |
| --- | --- | --- | --- |
| engineer | David Rossi | Kpff | `4127` |
| architect | Thoms R. Hughes | Tpg Architecture Llp | `C36476` |
| engineer | Matthew Debevec | Frch Design Worldwide | `M35990` |
| engineer | James Tavernelli | Klh Engineers | `E21678` |
| pmt consultant/expediter | Michael Verity | *(absent)* | *(absent)* |

Why it is the first backup, and how the pitch differs:

- **It is the live demonstration of the `max()` valuation rule.** `revised_cost` is the literal string `"0.0"`
  on a $14.15M project, because the permit was filed six days before the extract was taken and the revised
  figure had not been entered. Preferring `revised_cost` would score this as a zero-dollar job and discard the
  largest clinic project in the window. This record is the reason correction C4 in the kickoff review is not
  academic.
- **The description names electrical work explicitly**, in the applicant's own words.
- **There is no contractor row at all.** No `role: "contractor"` among the five. At `filed` stage the GC has
  not been appointed. That makes the path in different from the hero's: the applicant is Michael Verity, the
  permit expediter (`is_applicant: "Y"`), and the architect of record is TPG Architecture. Earlier stage,
  earlier conversation, less certain outcome.
- **KLH Engineers holds `E21678`**, so the electrical engineer of record is appointed even though no
  contractor is. Design ahead of construction, same shape as the hero.
- Note the out-of-state design team: TPG in New York, FRCH in Ohio, KLH in Kentucky. Only KPFF is local. This
  is a national tenant's rollout, which is useful colour but not a scored signal.

### 3.2 202604239978, 55 Spear St

**$9,052,500 office tenant improvement on floor 30, issued 2026-06-15, Skyline Construction again.**

| Field | Value |
| --- | --- |
| Address | 55 Spear St, zip `94105`, district `6`, Financial District/South Beach |
| Block / lot | `3713` / `007` |
| Status | `issued`. Filed `2026-04-23T12:05:42.000`, approved and issued `2026-06-15T15:58:07.000`, 53.2 days |
| Type | `permit_type` `8`, `otc alterations permit` |
| Use | `office`, occupancy `B`, 42 stories, construction type 1, `existing_units: "0.0"` |
| Costs | `estimated_cost` and `revised_cost` both `"9052500.0"` |
| Valuation | `9,052,500` |
| `record_id` | `1747732522056` |
| Description | `30th fl - ti (n) non-structural partitions, mep, finishes. demo under pa 202604018733. no exterior or structural work` |

Gate trace: 1 `zipcode: "94105"` passes. 2 `issued` passes. 3 `otc alterations permit` passes. 4 `office`
passes. 5 $9,052,500 passes. **Clears all six.**

Contacts, three rows, group id `1218379`:

| Role | Name | Firm | `license1` | SF business licence | `from_date` |
| --- | --- | --- | --- | --- | --- |
| contractor | Fabian Valdiosera | Skyline Construction | `727637` | `1109804` | 2026-06-15 |
| authorized agent-others | Schaeffer Nelson | Gary Bell Associates | *(absent)* | *(absent)* | 2026-04-23 |
| architect | Luda Hoe | Gensler | `C38081` | *(absent)* | 2026-04-23 |

Why it is a backup rather than the hero:

- **Same general contractor, same individual contact.** Fabian Valdiosera at Skyline Construction, identical
  CSLB `727637` and SF business licence `1109804`. Two $8M-plus office fit-outs with the same GC inside three
  months is a genuine relationship signal, and it makes this record a strong second beat rather than a
  substitute for the first.
- The `from_date` pattern repeats: the GC joins on `2026-06-15`, the same day the permit issues, while the
  architect and agent joined at filing on `2026-04-23`.
- **Scope is weaker in the description.** It says `mep`, an abbreviation covering mechanical, electrical, and
  plumbing together, rather than the hero's explicit `lighting, power and communication`. The electrical
  content has to be inferred from an abbreviation instead of read directly, which makes it a less clean
  demonstration of the deterministic and interpretation layers agreeing.
- No electrical engineer is named either, so unlike the hero there is no evidence the electrical design is
  complete.

### 3.3 202604209747, 149 New Montgomery St

**$5,670,000 commercial tenant improvement on floors 5 and 6, issued 2026-07-15.**

| Field | Value |
| --- | --- |
| Address | 149 New Montgomery St, zip `94105`, district `6`, Financial District/South Beach |
| Block / lot | `3722` / `007` |
| Status | `issued`. Filed `2026-04-20T15:05:00.000`, approved and issued `2026-07-15T12:16:17.000`, 85.9 days |
| Type | `permit_type` `8`, `otc alterations permit` |
| Use | `office`, occupancy `B,A-2,M`, 6 stories, construction type 3 |
| Costs | `estimated_cost` and `revised_cost` both `"5670000.0"` |
| Valuation | `5,670,000` |
| `record_id` | `1747477348621` |
| Description | `commercial tenant improvement of (e) floors 5 & 6.` |

Gate trace: 1 `zipcode: "94105"` passes. 2 `issued` passes. 3 `otc alterations permit` passes. 4 `office`
passes. 5 $5,670,000 passes. **Clears all six.**

Contacts, six rows, group id `1218143`:

| Role | Name | Firm | `license1` | SF business licence | `from_date` |
| --- | --- | --- | --- | --- | --- |
| engineer | Stephen Shaffer | California Electric Design | `E21097` | *(absent)* | 2026-04-20 |
| architect | Victoria Salgado | *(absent)* | `C37053` | *(absent)* | 2026-04-20 |
| engineer | Ivano Russo | *(absent)* | `M34415` | *(absent)* | 2026-04-20 |
| pmt consultant/expediter | Mahmoud Larizadeh | Reuben, Junius & Rose, Llp. | *(absent)* | *(absent)* | 2026-04-20 |
| contractor | Brandon John Jones | Principal Builders Inc. | `829808` | `0372229` | 2026-07-15 |
| authorized agent-others | John Trevor | Reuben Junuis & Rose Llp | *(absent)* | *(absent)* | 2026-07-15 |

Why it is the third backup, with an honest caveat:

- The GC is **Principal Builders Inc.**, CSLB `829808`, SF business licence `0372229`, joining on
  `2026-07-15`, the issue date. A different general contractor from the other two records, which is useful for
  showing the pipeline is not a single relationship.
- **Caveat, and the reason this is third: a firm named "California Electric Design" is on the permit.** Its
  `role` is `engineer` and its licence `E21097` is an electrical PE number, so it is the electrical *designer*,
  not the installing contractor. The claim "no electrical contractor is named" remains literally true, and the
  only `role: "contractor"` row is Principal Builders. But a judge or a subscriber scanning the roster will
  see the word "Electric" and reasonably ask. The hero has no such ambiguity, which is why the hero is the
  hero.
- **The description is the weakest of the four.** `commercial tenant improvement of (e) floors 5 & 6.` names
  no trade at all. Electrical scope is inferred from the presence of an electrical engineer of record, not
  from the applicant's words. That inference should be labelled `inferred`, never `verified`.
- **This record also demonstrates correction C8 on firm-name variants.** The same law firm appears twice on
  this one permit under two spellings: `Reuben, Junius & Rose, Llp.` and `Reuben Junuis & Rose Llp`, the
  second a misspelling of the firm's own name. Eight distinct spellings of that firm exist across the extract.
  Firm identity must key on `license1` where one exists, never on the name string.

### 3.4 The four side by side

| | Hero 202603238106 | 202607295760 | 202604239978 | 202604209747 |
| --- | --- | --- | --- | --- |
| Address | 555 California St | 100 Stockton St | 55 Spear St | 149 New Montgomery St |
| Valuation | $8,285,917 | $14,150,000 | $9,052,500 | $5,670,000 |
| Status | issued | filed | issued | issued |
| Use | office | clinics-medic/dental | office | office |
| Filed to issued | 18.0 days | not yet issued | 53.2 days | 85.9 days |
| GC on record | Skyline Construction | **none** | Skyline Construction | Principal Builders Inc. |
| Electrical engineer | PAE, `E19515` | KLH, `E21678` | none | California Electric Design, `E21097` |
| Electrical contractor | **none** | **none** | **none** | **none** |
| Scope in description | explicit: lighting, power, communication | explicit: electrical, hvac, plumbing | abbreviated: mep | none named |
| Clears all six gates | yes | yes | yes | yes |
| Exercises `max()` rule | no | **yes** | no | no |

---

## 4. Why the hero over the eight larger records

The hero ranks **9th of 694** by valuation. Eight surviving records carry a higher number, and two of those
eight are the backups in section 3. The hero was not chosen on dollar value, so the six remaining records and
the reason each was passed over are recorded here.

| Rank | Permit | Valuation | Address | Status | Why not the hero |
| --- | --- | --- | --- | --- | --- |
| 1 | 202606123167 | $90,000,000 | 3333 California St | filed | **Residential conversion in disguise.** `existing_use` is `office`, but `proposed_use` is `apartments`, `proposed_units` is `92.0`, and `proposed_occupancy` moves from `B,S-2` to `R-2,A-3,S-2`. The finished building is housing. Also a campus masterplan phase (`ed17-02 priority: (center b)`), too large to be a discrete electrical package. Two contacts only, no GC. |
| 2 | 202606123166 | $35,000,000 | 3333 California St | filed | Sibling permit, same campus, same conversion. `office` to `apartments`, `proposed_units` `44.0`. Same objections. |
| 3 | 202512292849 | $16,200,000 | 150 Oak St | issued | Genuine alternative and the strongest of the six. GC is Related California Construction Llc, CSLB `1061561`. Passed over because `existing_use` is `school` rather than `office`, and the description names the trade only as an abbreviation (`voluntary & selective renovation of (e) mep systems`). Weaker scope evidence than the hero's explicit wording. |
| 4 | 202602266569 | $15,855,932 | 185 Berry St | issued | Strong record, GC Hathaway Dinwiddie Co., CSLB `729664`. Passed over because the description (`6th fl: interior improvement for sierra in the wharfside of the building. approx 69,918 sqft`) names no trade whatsoever. Electrical scope would have to be inferred entirely. |
| 6 | 202602276723 | $12,718,000 | 185 Berry St | issued | Same building, same tenant, same GC as rank 4. A second permit on one project. Using it would make the pipeline look like it found one job twice. |
| 8 | 202604109211 | $8,750,000 | 1 Embarcadero Center | issued | Close second on quality. Six contacts including three engineers, and the description reaches mechanical scope (`related mechan...`). Passed over because **no contractor row exists**, so there is no GC to call, which is the entire point of the hero's pitch beat. |

Ranks 5 and 7 are backups 202607295760 and 202604239978, covered in section 3.

### 4.1 The filter gap ranks 1 and 2 exposed

Checking these records surfaced a real defect in the gate set traced in section 2. **Gate 4 tests
`existing_use` only.** The two 3333 California St records are commercial today and residential when finished,
so they pass a gate that reads only the current use.

Measured across the extract: 30 permits convert commercial to residential, and 15 convert residential to
commercial. Nine of the 30 clear all six gates and sit in the 694 survivors:

| Permit | Valuation | `existing_use` to `proposed_use` |
| --- | --- | --- |
| 202606123167 | $90,000,000 | office to apartments |
| 202606123166 | $35,000,000 | office to apartments |
| 202603238063 | $1,500,000 | manufacturing to apartments |
| 202606163278 | $450,000 | retail sales to 2 family dwelling |
| 202512182123 | $350,000 | prkng garage/private to 1 family dwelling |
| 202604169600 | $350,000 | prkng garage/private to 1 family dwelling |
| 202506239197 | $175,000 | prkng garage/private to 1 family dwelling |
| 202601304927 | $147,223 | prkng garage/private to 1 family dwelling |
| 202603167652 | $105,717 | office to 2 family dwelling |

Nine of 694 is 1.3% of the shortlist, and it includes the two largest records in it. The shortlist filter must
require **both** `existing_use` and `proposed_use` to be non-residential, not just `existing_use`. Recorded as
correction C11 in `docs/mappings.md`. Note that a residential `proposed_use` should exclude, while an
**absent** `proposed_use` (2.92% of rows) should not, because absent is unknown rather than residential and
2.92% of good leads is too much to discard on a missing field.

The hero is unaffected: `existing_use` and `proposed_use` are both `office`, and `existing_occupancy` and
`proposed_occupancy` are both `B`. It passes the corrected gate as well as the traced one.

### 4.2 The selection principle

The hero was chosen for evidence quality over headline value. It is the record where every link in the chain
is quoted rather than inferred: the trade scope is in the applicant's own words, the GC is named with a
verified licence, the electrical design is stamped under an `E` prefix licence, the buyout timing is visible in
`from_date`, and no electrical contractor appears anywhere. Of the eight larger records, two are residential
conversions, two are the same project counted twice, one has no GC to call, and the rest name no trade. A
larger number with a weaker chain is a worse demo, because the thing being demonstrated is the evidence
discipline, not the size of the lead.

---

## 5. Evidence labels for the hero

How each fact about the hero should be stored, per CLAUDE.md hard rule #3. This is the expected `Finding` set
for candidate 202603238106.

| Key | Value | Evidence | Basis |
| --- | --- | --- | --- |
| `project.valuation` | `8285917` | `verified` | `revised_cost` and `estimated_cost` agree on the first-party agency record |
| `project.address` | `555 California St, San Francisco 94104` | `verified` | Permit record, `primary_address_flag: "Y"` |
| `project.status` | `issued` | `verified` | Permit record |
| `project.issued_date` | `2026-04-10T15:03:06.000` | `verified` | Permit record |
| `project.use` | `office` | `verified` | Permit record `existing_use` |
| `project.stories` | `52` | `verified` | Permit record |
| `scope.electrical` | `true` | `verified` | Description names `(n) lighting, power and communication fixtures` in the applicant's own words |
| `gc.firm_name` | `Skyline Construction` | `verified` | Contacts record, `role: "contractor"` |
| `gc.license_number` | `727637` | `verified` | Contacts record `license1` |
| `gc.sf_business_license` | `1109804` | `verified` | Contacts record |
| `gc.joined_permit` | `2026-04-03` | `verified` | Contacts record `from_date` |
| `electrical.engineer_of_record` | `Pae Engineers (E19515)` | `verified` | Contacts record, `E` prefix is the electrical discipline |
| `electrical.contractor_named` | `false` | `verified` | Zero contractor rows other than Skyline; zero rows mention "electric" |
| `architect.firm_name` | `null` | `unknown` | `firm_name` absent on the architect row |
| `gc.license_status` | `null` | `unknown` | CSLB not obtainable, correction C9 |
| `gc.classification` | `null` | `unknown` | Same |
| `gc.phone` | `null` | `unknown` | Dataset carries no phone column |
| `project.completion_date` | `null` | `unknown` | `completed_date` absent |
| `electrical.package_awarded` | `null` | `unknown` | Not observable from a permit. The sub may be chosen and unfiled. |

The last row is the one to defend under questioning. The system knows no electrical contractor is *named on
the permit*. It does not know whether the work is *awarded*. Those are different claims and the second one is
never made.

---

## 6. Replay positioning

The hero's own timestamps place it naturally inside the extract's six month window
(`filed_date` range `2026-02-15T15:11:24.000` to `2026-08-14T18:05:07.000`):

| Event | Timestamp |
| --- | --- |
| Filed | `2026-03-23T14:30:55.000` |
| GC added | `2026-04-03T00:00:00.000` |
| Approved and issued | `2026-04-10T15:03:06.000` |
| Agency currency (`data_as_of`) | `2026-04-12T01:05:02.000` |

The replay harness stages records at their original timestamps and releases them on the accelerated clock, so
the hero enters the pipeline at its real filing position with the GC appearing eleven days later, exactly as it
happened. No timestamp is rewritten to suit the demo, and the UI carries the replay label (CLAUDE.md hard
rule #5).

Timestamps in the extract carry no timezone designator and are San Francisco wall-clock times. The replay
harness must attach the `America/Los_Angeles` offset rather than treating them as UTC, or the hero will land
seven or eight hours out of position. See correction C4 in `docs/mappings.md`.

---

## 7. How to re-verify

Run from the repo root, `C:/dev/LeadVelocity`. Each command reads the committed extract and prints a result
you can check by eye. All four were executed against the extract while writing this document, and the actual
output is shown.

**Is the hero still in the extract, with the expected address, status, and valuation?**

```bash
node -e "const h=JSON.parse(require('fs').readFileSync('data/permits.json','utf8')).filter(r=>r.permit_number==='202603238106');console.log(h.length===1?'HERO OK '+h[0].street_number+' '+h[0].street_name+' '+h[0].street_suffix+' | '+h[0].status+' | \$'+Math.max(+h[0].revised_cost||0,+h[0].estimated_cost||0).toLocaleString():'HERO MISSING')"
```

```
HERO OK 555 California St | issued | $8,285,917
```

**Is the contact roster intact, and is it still true that no electrical contractor is named?**

```bash
node -e "const c=JSON.parse(require('fs').readFileSync('data/contacts.json','utf8')).filter(r=>r.permit_number==='202603238106');console.log(c.length+' contacts:',c.map(x=>x.role+'='+(x.firm_name||x.first_name+' '+x.last_name)).join(' | '));console.log('electrical contractor present:',c.some(x=>x.role==='contractor'&&/electric/i.test(x.firm_name||'')))"
```

```
5 contacts: contractor=Skyline Construction | authorized agent-others=Reuben, Junius & Rose, Llp. | engineer=Pae Engineers | engineer=Pae | architect=Mark Walsh
electrical contractor present: false
```

**Do the hero and all three backups still clear every gate?**

```bash
node -e "const P=JSON.parse(require('fs').readFileSync('data/permits.json','utf8'));const X=new Set(['1 family dwelling','2 family dwelling','apartments','residential hotel','misc group residns.','artist live/work','vacant lot','storage shed','accessory cottage']);const T=new Set(['sign - erect','wall or painted sign','demolitions','grade or quarry or fill or excavate']);const O=new Set(['filed','issued','approved','reinstated']);const g=new Map();for(const p of P){if(!g.has(p.permit_number))g.set(p.permit_number,[]);g.get(p.permit_number).push(p)}const d=[...g.values()].map(v=>v.find(x=>x.primary_address_flag==='Y')||v[0]);const s=d.filter(p=>p.zipcode).filter(p=>O.has(p.status)).filter(p=>!T.has(p.permit_type_definition)).filter(p=>p.existing_use&&!X.has(p.existing_use)).filter(p=>Math.max(+p.revised_cost||0,+p.estimated_cost||0)>=100000);console.log('survivors',s.length);for(const n of ['202603238106','202607295760','202604239978','202604209747'])console.log(n,s.some(p=>p.permit_number===n)?'PASS':'FAIL')"
```

```
survivors 694
202603238106 PASS
202607295760 PASS
202604239978 PASS
202604209747 PASS
```

**Is the 1% claim in section 2.1 still true?**

```bash
node -e "const P=JSON.parse(require('fs').readFileSync('data/permits.json','utf8')),C=JSON.parse(require('fs').readFileSync('data/contacts.json','utf8'));const X=new Set(['1 family dwelling','2 family dwelling','apartments','residential hotel','misc group residns.','artist live/work','vacant lot','storage shed','accessory cottage']);const T=new Set(['sign - erect','wall or painted sign','demolitions','grade or quarry or fill or excavate']);const O=new Set(['filed','issued','approved','reinstated']);const g=new Map();for(const p of P){if(!g.has(p.permit_number))g.set(p.permit_number,[]);g.get(p.permit_number).push(p)}const s=[...g.values()].map(v=>v.find(x=>x.primary_address_flag==='Y')||v[0]).filter(p=>p.zipcode&&O.has(p.status)&&!T.has(p.permit_type_definition)&&p.existing_use&&!X.has(p.existing_use)&&Math.max(+p.revised_cost||0,+p.estimated_cost||0)>=100000);const b=new Map();for(const c of C){if(!b.has(c.permit_number))b.set(c.permit_number,[]);b.get(c.permit_number).push(c)}const e=s.filter(p=>(b.get(p.permit_number)||[]).some(c=>c.role==='contractor'&&/electric/i.test(c.firm_name||''))).length;console.log('survivors',s.length,'already naming an electrical contractor',e,((e/s.length)*100).toFixed(1)+'%')"
```

```
survivors 694 already naming an electrical contractor 7 1.0%
```

If the first command prints `HERO MISSING`, the extract has been replaced. Re-run the DataSF pull, then rebuild
this document from the new extract rather than editing the numbers in place. Every figure in this file is a
measurement of one specific extract, identified by the `retrieved_at` stamp in `data/manifest.json`
(`2026-08-15T16:47:00.415Z`).
