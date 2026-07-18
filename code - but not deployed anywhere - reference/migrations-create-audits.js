// migrations/YYYYMMDDHHMMSS-create-audits.js
//
// DRAFT migration, in sequelize-cli's standard up/down format. Rename with
// a real timestamp prefix when actually run (sequelize-cli generates this
// automatically via `npx sequelize-cli migration:generate --name create-audits`
// — this file is hand-written to match that expected shape exactly).
//
// Mirrors models/audit.model.js exactly — see that file for field-by-field
// reasoning. If the model changes, this migration must change to match.

'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('audits', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      loanId: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      date: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      auditor: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      tw: {
        type: Sequelize.FLOAT,
        allowNull: true,
      },
      twRecheckedBy: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      twUpdatedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      excessFunding: {
        type: Sequelize.ENUM('Yes', 'No'),
        allowNull: false,
        defaultValue: 'No',
      },
      excessAmount: {
        type: Sequelize.FLOAT,
        allowNull: true,
      },
      spurious: {
        type: Sequelize.ENUM('Yes', 'No'),
        allowNull: false,
        defaultValue: 'No',
      },
      spuriousOrnaments: {
        type: Sequelize.JSONB,
        allowNull: true,
        defaultValue: [],
      },
      city: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      branch: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      loanAmount: {
        type: Sequelize.FLOAT,
        allowNull: false,
      },
      loanBookingDate: {
        type: Sequelize.DATEONLY,
        allowNull: true,
      },
      remarks: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      newPacketId: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      ornaments: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      submittedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      source: {
        type: Sequelize.ENUM('metabase-sync'),
        allowNull: true,
      },
      syncedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex('audits', ['loanId']);
    await queryInterface.addIndex('audits', ['date']);
    await queryInterface.addIndex('audits', ['source']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('audits');
  },
};
