/** Shared constants. No secrets. The OAuth client id lives in config.js, not here. */

export const SCHEMA_VERSION = 1;
export const APP_PROPERTY_KEY = 'financeTracker';
export const APP_PROPERTY_VALUE = '1';
export const SHEET_TITLE = 'Finance Tracker';
export const STORAGE_PREFIX = 'finance-tracker:v1';
export const LEGACY_STORAGE_KEY = 'finance-tracker-v1';

/** Tabs created in each user's private spreadsheet. */
export const TAB_NAMES = ['Transactions', 'Budgets', 'Goals', 'Settings', 'Summary'];

export const EXPENSE_CATS = [
  'Housing', 'Food', 'Transport', 'Utilities', 'Healthcare',
  'Entertainment', 'Shopping', 'Subscriptions', 'Debt', 'Other'
];

export const INCOME_CATS = ['Salary', 'Freelance', 'Investments', 'Gifts', 'Other income'];

export const CAT_EMOJI = {
  Housing: '🏠', Food: '🍔', Transport: '🚗', Utilities: '💡', Healthcare: '🩺',
  Entertainment: '🎬', Shopping: '🛍️', Subscriptions: '🔁', Debt: '💳', Other: '📦',
  Salary: '💼', Freelance: '💻', Investments: '📈', Gifts: '🎁', 'Other income': '💰'
};

/**
 * Identity scopes are required. drive.file alone does not return a stable
 * account id, so two people on one browser could not be isolated.
 * All four are non-sensitive. Do not add spreadsheets or full drive scopes.
 * https://developers.google.com/workspace/sheets/api/scopes
 * https://developers.google.com/identity/oauth2/web/guides/use-token-model
 */
export const REQUIRED_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/drive.file'
];

export const TX_HEADERS = [
  'id', 'type', 'amount', 'category', 'date', 'note',
  'recurring', 'deleted', 'created_at', 'updated_at'
];

export const BUDGET_HEADERS = [
  'id', 'category', 'monthly_limit', 'deleted', 'created_at', 'updated_at'
];

export const GOAL_HEADERS = [
  'id', 'name', 'target', 'current_amount', 'target_date',
  'monthly_contribution', 'deleted', 'created_at', 'updated_at'
];

export const MAX_ROWS = 5000;
export const FORMULA_ROWS = 200;
