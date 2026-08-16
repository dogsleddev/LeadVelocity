export const db = {
  subscriber: {
    company: "Mike's Commercial Electric",
    profile: [
      { q: "What do you do?", a: "Commercial electrical" },
      { q: "Where do you work?", a: "San Francisco" },
      { q: "What projects do you want?", a: "Labs, healthcare, industrial, commercial TI" },
      { q: "Minimum job size?", a: "$25,000" }
    ]
  },
  hero: {
    id: "opp-96",
    score: 96,
    badge: "96 / 100 · High Priority",
    title: "Arcadia Biosciences Lab Conversion, San Francisco",
    subtitle: "31,500 SF laboratory tenant improvement",
    rows: [
      { label: "What it is", text: "Full lab fit-out with new electrical distribution and standby power. Permit filed last week." },
      { label: "Why it fits", text: "Labs and commercial TI are your target work, and the scope is well above your $25,000 minimum." },
      { label: "Who to call", text: "Dana Reyes, Project Executive, Meridian Builders (GC)." },
      { label: "Why now", text: "The GC is assembling subs now. No electrical sub is on record yet." }
    ],
    chips: ["Verified", "Corroborated", "Inferred", "Unknown"],
    evidence: [
      { fact: "Permit filed with SF DBI", chip: "Verified", source: "SF DBI permit record, filed Aug 6" },
      { fact: "General contractor identified from permit contacts", chip: "Corroborated", source: "Permit contact listing plus GC website" },
      { fact: "Substantial electrical scope likely", chip: "Inferred", source: "Scope analysis of permit description" },
      { fact: "Electrical sub already selected", chip: "Unknown", source: "No public record found" }
    ],
    contact: { name: "Dana Reyes", role: "Project Executive", company: "Meridian Builders" },
    action: "Call Dana this week, reference the DBI permit, and ask to bid the electrical package before the sub list closes.",
    drivers: [
      { name: "Fit", got: 29, max: 30 },
      { name: "Demand", got: 24, max: 25 },
      { name: "Timing", got: 19, max: 20 },
      { name: "Value", got: 14, max: 15 },
      { name: "Evidence", got: 10, max: 10 }
    ]
  },
  inbox: [
    { id: "opp-96", score: 96, badge: "96 / 100 · High Priority", title: "Arcadia Biosciences Lab Conversion", subtitle: "31,500 SF laboratory tenant improvement", when: "Today, 9:41 AM", viewed: false, hot: true, lat: 37.7695, lng: -122.3927, area: "Mission Bay" },
    { id: "opp-88", score: 88, badge: "88 / 100 · Qualified", title: "Parnassus Outpatient Clinic Refresh", subtitle: "12,400 SF medical office electrical upgrade", when: "Yesterday", viewed: true, hot: false, lat: 37.7631, lng: -122.4586, area: "Inner Sunset" },
    { id: "opp-84", score: 84, badge: "84 / 100 · Qualified", title: "Dogpatch Cold Storage Retrofit", subtitle: "8,900 SF industrial power distribution upgrade", when: "Tuesday", viewed: true, hot: false, lat: 37.7583, lng: -122.3894, area: "Dogpatch" }
  ],
  details: {
    "opp-88": {
      rows: [
        { label: "What it is", text: "Medical office electrical upgrade across two floors: new panels, exam room circuits, low-voltage rough-in." },
        { label: "Why it fits", text: "Healthcare TI in your territory, scope well above your $25,000 minimum." },
        { label: "Who to call", text: "Priya Natarajan, Preconstruction Manager, Hearth Construction (GC)." },
        { label: "Why now", text: "Permit approved, sub buyout underway this month." }
      ],
      evidence: [
        { fact: "Permit approved by SF DBI", chip: "Verified", source: "SF DBI permit record, approved Jul 28" },
        { fact: "General contractor identified from plan set", chip: "Corroborated", source: "Plan set title block plus GC website" },
        { fact: "Standby power scope likely", chip: "Inferred", source: "Scope analysis of permit description" }
      ],
      contact: { name: "Priya Natarajan", role: "Preconstruction Manager", company: "Hearth Construction" },
      action: "Email Priya with healthcare project references and ask for the electrical bid package.",
      drivers: [
        { name: "Fit", got: 26, max: 30 }, { name: "Demand", got: 22, max: 25 }, { name: "Timing", got: 17, max: 20 }, { name: "Value", got: 13, max: 15 }, { name: "Evidence", got: 10, max: 10 }
      ]
    },
    "opp-84": {
      rows: [
        { label: "What it is", text: "Power distribution upgrade for a refrigerated warehouse: new 800A service and equipment feeders." },
        { label: "Why it fits", text: "Industrial work in your segment, well above minimum job size." },
        { label: "Who to call", text: "Tom Okafor, Facilities Director, BayCold Logistics (owner)." },
        { label: "Why now", text: "Owner is collecting bids directly through September." }
      ],
      evidence: [
        { fact: "Service upgrade permit filed with SF DBI", chip: "Verified", source: "SF DBI permit record, filed Aug 4" },
        { fact: "Owner-managed bid process", chip: "Corroborated", source: "Owner RFP listing plus facilities contact" },
        { fact: "Controls scope included", chip: "Unknown", source: "No public record found" }
      ],
      contact: { name: "Tom Okafor", role: "Facilities Director", company: "BayCold Logistics" },
      action: "Call Tom directly: owner-run bid list closes in six weeks.",
      drivers: [
        { name: "Fit", got: 25, max: 30 }, { name: "Demand", got: 21, max: 25 }, { name: "Timing", got: 16, max: 20 }, { name: "Value", got: 12, max: 15 }, { name: "Evidence", got: 10, max: 10 }
      ]
    }
  },
  feed: [
    { t: "09:41:22", agent: "Lead Agent", decision: "Delivered Opportunity opp-96, ScoreOutput 96 / 100, to Mike's Commercial Electric", reason: "Cleared the 85 threshold. All five score drivers strong after evidence upgrade.", kind: "delivered" },
    { t: "09:38:05", agent: "Human Expert", decision: "Hired expert, 5 minutes: Is an electrical sub selected? Answer: no. Evidence upgraded, rescored.", reason: "Finding 'Electrical sub already selected' moved from Unknown to Verified: no.", kind: "expert" },
    { t: "09:31:48", agent: "Lead Agent", decision: "Archived Opportunity opp-102, ScoreOutput 41 / 100", reason: "Residential remodel, outside segment scope and below minimum job size.", kind: "normal" },
    { t: "09:27:10", agent: "Sales Agent", decision: "Qualified prospect: Delta Bay Electric, sent sample Opportunity by text", reason: "Licensed C-10, service area overlaps SF territory, 12 person crew.", kind: "normal" },
    { t: "09:19:33", agent: "Customer Agent", decision: "Updated profile for Mike's Commercial Electric", reason: "Two 'Too small' responses this month. Raised minimum job size to $25,000.", kind: "normal" },
    { t: "09:05:51", agent: "CEO Agent", decision: "Reallocated acquisition spend toward commercial electrical segment", reason: "40 percent lead acceptance vs 10 percent in the test segment.", kind: "normal" },
    { t: "08:58:12", agent: "Lead Agent", decision: "Archived Opportunity opp-101, ScoreOutput 62 / 100", reason: "Timing weak: permit approved 14 months ago, subs likely locked.", kind: "normal" },
    { t: "08:49:37", agent: "Sales Agent", decision: "Disqualified prospect: Golden Gate Handyman Services", reason: "Residential focus, no commercial license class on file.", kind: "normal" }
  ],
  ceo: {
    stats: [
      { label: "MRR", value: "$6,407", note: "43 subscribers at $149", money: true },
      { label: "Active subscribers", value: "43", note: "+6 this month", money: false },
      { label: "Delivered vs archived", value: "118 : 1,204", note: "1 in 11 clears the bar. Selectivity is the product.", money: false },
      { label: "Customer retention", value: "92%", note: "Trailing 90 days", money: false }
    ],
    economics: [
      { label: "Subscription", value: "$149", plus: true },
      { label: "Data", value: "$3", plus: false },
      { label: "Enrichment", value: "$7", plus: false },
      { label: "Compute", value: "$5", plus: false },
      { label: "Messaging", value: "$2", plus: false },
      { label: "Payments", value: "$5", plus: false },
      { label: "Contribution", value: "$127", plus: true, total: true }
    ],
    segments: [
      { name: "Commercial electrical", subs: 41, acceptance: "40%", retention: "94%", primary: true },
      { name: "Commercial HVAC (test)", subs: 2, acceptance: "10%", retention: "68%", primary: false }
    ],
    decision: { title: "Shifting acquisition toward commercial electrical: 40 percent lead acceptance vs 10 percent.", by: "CEO Agent", when: "Today, 9:05 AM" }
  }
};
