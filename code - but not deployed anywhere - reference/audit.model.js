// models/audit.model.js
//
// DRAFT Sequelize model for the `audits` table — NOT wired into any running
// app. Written to match tenmark-data-dictionary.md and
// tenmark-audit-app.types.ts field-for-field. Exists purely as a
// migration-prep artifact: ready to hand to Tenmark's backend team, or to
// use directly once DB access / schema ownership is confirmed.
//
// DESIGN DECISION: ornaments is stored as a single JSONB column, not a
// separate child table. Reasoning:
//   - Matches the current Firestore shape almost exactly (an audit doc with
//     a nested ornaments array) — lowest-risk, least-transformation path
//     for a first migration pass.
//   - Ornaments are never queried/filtered independently of their parent
//     audit anywhere in the current app (confirmed against
//     tenmark-data-dictionary.md and the app's own query patterns) — there
//     is no existing use case that needs SQL-level joins/filters on
//     individual ornament fields.
//   - A normalized child-table version (one row per ornament, FK to
//     audits.id) is the natural alternative IF Tenmark's team wants
//     ornament-level SQL queries later — sketched as a comment at the
//     bottom of this file for that discussion, not built out, since it's a
//     real design decision that shouldn't be made unilaterally here.
//
// Requires: sequelize, and a Postgres driver (pg) in the real project.

const { Model, DataTypes } = require('sequelize');

class Audit extends Model {
  static initModel(sequelize) {
    Audit.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
          // NOTE: using UUID here as a draft default. Firestore's own doc
          // IDs are opaque strings, not sequential — a UUID preserves that
          // property. If Tenmark's existing tables use auto-increment
          // integers instead (open question — see integration question
          // list), swap this for DataTypes.INTEGER with autoIncrement:true.
        },
        loanId: {
          type: DataTypes.STRING,
          allowNull: false,
          // Deliberately NOT unique — a single loanId can have MULTIPLE
          // Audit rows (re-audits create new rows, never overwrite). See
          // the dedup rule in computeDedupedAudits()/computeAuditedLoansForTW()
          // in app.js — "most recent by date wins" logic must be
          // reimplemented at the query layer (ORDER BY date DESC, or a
          // dedicated "latest" view/query) wherever this table is read.
        },
        date: { type: DataTypes.DATEONLY, allowNull: false },
        auditor: { type: DataTypes.STRING, allowNull: false },
        tw: { type: DataTypes.FLOAT, allowNull: true },
        twRecheckedBy: { type: DataTypes.STRING, allowNull: true },
        twUpdatedAt: { type: DataTypes.DATE, allowNull: true },
        // _twSubmitted is intentionally NOT a column — see
        // tenmark-audit-app.types.ts: it's a client-side-only, non-persisted
        // UI flag and must never be written to a real DB either.
        excessFunding: {
          type: DataTypes.ENUM('Yes', 'No'),
          allowNull: false,
          defaultValue: 'No',
        },
        excessAmount: { type: DataTypes.FLOAT, allowNull: true },
        spurious: {
          type: DataTypes.ENUM('Yes', 'No'),
          allowNull: false,
          defaultValue: 'No',
        },
        spuriousOrnaments: {
          type: DataTypes.JSONB,
          allowNull: true,
          defaultValue: [],
        },
        city: { type: DataTypes.STRING, allowNull: true },
        branch: { type: DataTypes.STRING, allowNull: true },
        loanAmount: {
          type: DataTypes.FLOAT,
          allowNull: false,
          // See tenmark-data-dictionary.md — historically stored as a
          // formatted currency string on records predating the loanAmount
          // type fix. A migration script importing OLD Firestore records
          // must strip non-numeric characters before insert here, or this
          // column constraint will reject them outright (which is
          // arguably correct behavior — surfacing bad data at migration
          // time rather than silently accepting it).
        },
        loanBookingDate: { type: DataTypes.DATEONLY, allowNull: true },
        remarks: { type: DataTypes.TEXT, allowNull: true },
        newPacketId: { type: DataTypes.STRING, allowNull: true },
        ornaments: {
          type: DataTypes.JSONB,
          allowNull: false,
          defaultValue: [],
          // Shape matches the Ornament interface in
          // tenmark-audit-app.types.ts exactly — array of objects with
          // type/goldId/count/countAudit/gw/gwAudit/.../spurious.
          // IMPORTANT: gw/gwAudit are LINE TOTALS, never per-piece figures
          // — this rule lives in application logic, not enforceable by
          // the column type, but must be preserved by anything that reads
          // or writes this column.
        },
        submittedAt: { type: DataTypes.DATE, allowNull: false },
        source: {
          type: DataTypes.ENUM('metabase-sync'),
          allowNull: true,
          // Only present on nightly-sync placeholder rows not yet audited.
        },
        syncedAt: { type: DataTypes.DATE, allowNull: true },
      },
      {
        sequelize,
        modelName: 'Audit',
        tableName: 'audits',
        timestamps: false, // submittedAt/twUpdatedAt/syncedAt already cover this explicitly
        indexes: [
          // loanId is queried constantly (every dedup, every lookup) —
          // needs an index even though it's not unique.
          { fields: ['loanId'] },
          { fields: ['date'] },
          { fields: ['source'] },
        ],
      }
    );
    return Audit;
  }
}

module.exports = Audit;

// ─────────────────────────────────────────────────────
// ALTERNATIVE DESIGN (not built — for discussion only)
// ─────────────────────────────────────────────────────
// If ornament-level SQL queries become a real need later, a normalized
// version would look like:
//
//   class Ornament extends Model { ... }
//   Ornament.belongsTo(Audit, { foreignKey: 'auditId' });
//   Audit.hasMany(Ornament, { foreignKey: 'auditId', as: 'ornaments' });
//
// with an Ornament table carrying: id, auditId (FK), type, goldId, count,
// countAudit, gw, gwAudit, gwPC, karat, karatAudit, karatPC, nw, nwAudit,
// nwPC, stoneDed, stoneDedAudit, stoneDedPC, hallmark, spurious.
//
// This is a bigger schema-design decision (and a bigger migration script)
// than the JSONB version above — flagging it here rather than building it
// speculatively.
