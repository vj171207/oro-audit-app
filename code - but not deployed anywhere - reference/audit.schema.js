// schemas/audit.schema.js
//
// DRAFT Mongoose schema for the `audits` collection — NOT wired into any
// running app. Matches tenmark-data-dictionary.md and
// tenmark-audit-app.types.ts field-for-field. Exists purely as a
// migration-prep artifact.
//
// This is naturally the closer structural match to the CURRENT Firestore
// shape than the Sequelize/Postgres version — a Mongo document with an
// embedded ornaments array is nearly identical to a Firestore doc with a
// nested ornaments array. If Tenmark's team ends up choosing Mongo for
// this data (see the open migration question: "which DB fits our audit
// data better"), this is closer to a direct lift than a redesign.

const mongoose = require('mongoose');
const { Schema } = mongoose;

// ── Ornament sub-schema (embedded, not a separate collection) ──
const OrnamentSchema = new Schema(
  {
    type: { type: String, required: true },
    goldId: { type: String },
    count: { type: Number, required: true },
    countAudit: { type: Number },
    // gw/gwAudit are LINE TOTALS, never per-piece figures — enforced by
    // application logic, not by the schema; flagged here so it isn't lost.
    gw: { type: Number, required: true },
    gwAudit: { type: Number },
    gwPC: { type: Number },
    karat: { type: Number, required: true },
    karatAudit: { type: Number },
    karatPC: { type: Number },
    // nw formula: (GW - Stone) * (Karat/22) — computed in application
    // logic today, not by the DB. Preserve that on write, not as a
    // Mongoose virtual, to match current behavior exactly.
    nw: { type: Number, required: true },
    nwAudit: { type: Number },
    nwPC: { type: Number },
    stoneDed: { type: Number, required: true },
    stoneDedAudit: { type: Number },
    stoneDedPC: { type: Number },
    hallmark: { type: String },
    spurious: { type: String, enum: ['Yes', 'No'], required: true },
  },
  { _id: false } // ornaments don't need their own top-level ID in this app today
);

// ── Audit schema ──
const AuditSchema = new Schema({
  loanId: {
    type: String,
    required: true,
    index: true,
    // Deliberately NOT unique — see audit.model.js's equivalent note.
    // Multiple Audit docs per loanId are expected (re-audits); "most
    // recent by date wins" is application-layer logic
    // (computeDedupedAudits() in app.js), not a DB constraint.
  },
  date: { type: String, required: true }, // kept as 'YYYY-MM-DD' string to match current app.js date-comparison logic (string comparison, not Date objects)
  auditor: { type: String, required: true },
  tw: { type: Number, default: null },
  twRecheckedBy: { type: String },
  twUpdatedAt: { type: String }, // ISO string, to match current twUpdatedAt.slice(0,10) usage in app.js
  // _twSubmitted is intentionally NOT a field — client-side-only,
  // never persisted. See tenmark-audit-app.types.ts for the full note.
  excessFunding: { type: String, enum: ['Yes', 'No'], required: true, default: 'No' },
  excessAmount: { type: Number },
  spurious: { type: String, enum: ['Yes', 'No'], required: true, default: 'No' },
  spuriousOrnaments: { type: [String], default: [] },
  city: { type: String },
  branch: { type: String, index: true },
  loanAmount: {
    type: Number,
    required: true,
    // See tenmark-data-dictionary.md — old Firestore records may still
    // have this as a formatted currency string; a migration script must
    // coerce/strip before insert, since this schema enforces Number.
  },
  loanBookingDate: { type: String, default: null }, // ISO date string or null
  remarks: { type: String, default: '' },
  newPacketId: { type: String, default: '' },
  ornaments: { type: [OrnamentSchema], default: [] },
  submittedAt: { type: String, required: true }, // ISO string
  source: { type: String, enum: ['metabase-sync'] },
  syncedAt: { type: String },
}, {
  collection: 'audits',
  timestamps: false, // submittedAt/twUpdatedAt/syncedAt already cover this explicitly
});

AuditSchema.index({ loanId: 1, date: -1 }); // supports the "most recent per loanId" dedup pattern directly

const Audit = mongoose.model('Audit', AuditSchema);

module.exports = { Audit, OrnamentSchema, AuditSchema };
