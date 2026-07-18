// validation/schemas.js
//
// DRAFT Joi validation schemas — one per /api/*.js endpoint's input. NOT
// wired into the running app (app.js still has its own manual `if (!x)`
// checks; these are a direct translation, not a replacement in place).
//
// PURPOSE: Tenmark's backend uses Joi + celebrate for request validation.
// These schemas are a mechanical translation of every validation rule that
// already exists in api/*.js today — same rules, same required fields,
// same length constraints — expressed in Joi's format so they can be
// dropped straight into a celebrate() middleware call once these endpoints
// get ported into their Express app. Nothing here invents a NEW rule; each
// schema is cross-referenced against its source file's manual checks (see
// the comment above each schema).
//
// Usage once ported (celebrate pattern, for reference):
//   const { celebrate, Segments } = require('celebrate');
//   router.post('/create-user', celebrate({ [Segments.BODY]: createUserSchema }), handler);

const Joi = require('joi');

// ── GET /api/browse-loans ──
// Source: api/browse-loans.js lines 12, 20 — both from and to required,
// both must match ^\d{4}-\d{2}-\d{2}$ (YYYY-MM-DD).
const browseLoansQuerySchema = Joi.object({
  from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
    .messages({
      'any.required': 'from and to dates are required',
      'string.pattern.base': 'from and to must be valid dates in YYYY-MM-DD format',
    }),
  to: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
    .messages({
      'any.required': 'from and to dates are required',
      'string.pattern.base': 'from and to must be valid dates in YYYY-MM-DD format',
    }),
});

// ── GET /api/loan-lookup ──
// Source: api/loan-lookup.js line 16 — loanId required. Note: the actual
// sanitization (stripping to alphanumeric+dash) happens in the handler
// AFTER this validation, not as part of it — this schema only enforces
// presence, matching current behavior exactly (it does not reject a
// loanId containing special characters; the handler strips them silently).
const loanLookupQuerySchema = Joi.object({
  loanId: Joi.string().required()
    .messages({ 'any.required': 'loanId is required' }),
});

// ── POST /api/tw-gross-weight ──
// Source: api/tw-gross-weight.js line 40 — loanIds must be a non-empty array.
const twGrossWeightBodySchema = Joi.object({
  loanIds: Joi.array().items(Joi.string()).min(1).required()
    .messages({
      'any.required': 'loanIds array is required in the request body',
      'array.min': 'loanIds array is required in the request body',
    }),
});

// ── POST /api/create-user ──
// Source: api/create-user.js lines 64, 67, 70 — email/password/role
// required, password >= 6 chars, role must be 'auditor' or 'manager'.
// callerToken is required by verifyCallerIsManager() (line 27) but that
// check happens in application logic, not as basic shape validation — kept
// as required here too since a request literally cannot succeed without it.
const createUserBodySchema = Joi.object({
  email: Joi.string().required()
    .messages({ 'any.required': 'Email, password and role are required.' }),
  password: Joi.string().min(6).required()
    .messages({
      'any.required': 'Email, password and role are required.',
      'string.min': 'Password must be at least 6 characters.',
    }),
  role: Joi.string().valid('auditor', 'manager').required()
    .messages({
      'any.required': 'Email, password and role are required.',
      'any.only': 'Invalid role.',
    }),
  callerToken: Joi.string().required()
    .messages({ 'any.required': 'Missing authentication. Please log in again.' }),
});

// ── POST /api/remove-user ──
// Source: api/remove-user.js line 84 — docId required. callerToken required
// per verifyCallerIsManager() (line 47), same note as above.
const removeUserBodySchema = Joi.object({
  docId: Joi.string().required()
    .messages({ 'any.required': 'docId is required.' }),
  callerToken: Joi.string().required()
    .messages({ 'any.required': 'Missing authentication. Please log in again.' }),
});

// ── POST /api/reset-password ──
// Source: api/reset-password.js lines 64-65 — email/newPassword required,
// newPassword >= 6 chars. callerToken required per verifyCallerIsManager()
// (line 28), same note as above.
const resetPasswordBodySchema = Joi.object({
  email: Joi.string().required()
    .messages({ 'any.required': 'Email and new password required.' }),
  newPassword: Joi.string().min(6).required()
    .messages({
      'any.required': 'Email and new password required.',
      'string.min': 'Password must be at least 6 characters.',
    }),
  callerToken: Joi.string().required()
    .messages({ 'any.required': 'Missing authentication. Please log in again.' }),
});

// ── POST /api/sync-loans ──
// Source: api/sync-loans.js — takes NO body; auth is via a Bearer header
// (CRON_SECRET), checked in application logic, not body validation. No
// schema needed for the body; included here as an explicit "empty" schema
// so the absence of a body schema isn't mistaken for an oversight.
const syncLoansBodySchema = Joi.object({}).unknown(false);

// ── GET /api/active-loans ──
// Source: api/active-loans.js — takes no parameters at all. No schema
// needed; included for completeness/documentation.
const activeLoansQuerySchema = Joi.object({}).unknown(false);

module.exports = {
  browseLoansQuerySchema,
  loanLookupQuerySchema,
  twGrossWeightBodySchema,
  createUserBodySchema,
  removeUserBodySchema,
  resetPasswordBodySchema,
  syncLoansBodySchema,
  activeLoansQuerySchema,
};
