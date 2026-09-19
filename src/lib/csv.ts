import Papa from 'papaparse';

/**
 * Normalizes a header string for flexible matching by lowercasing and stripping
 * all non-alphanumeric characters.
 *
 * Examples:
 * - "User Name" -> "username"
 * - "user_name" -> "username"
 * - "userName"  -> "username"
 * - "Portal ID" -> "portalid"
 */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Creates a header transformation function that maps normalized headers
 * and synonyms to target canonical property names.
 *
 * If a header is not in the alias map, its trimmed original form is returned.
 */
export function createHeaderTransformer(
  aliasMap: Record<string, string[]>,
): (header: string) => string {
  const lookup = new Map<string, string>();

  for (const [canonicalKey, aliases] of Object.entries(aliasMap)) {
    lookup.set(normalizeHeader(canonicalKey), canonicalKey);
    for (const alias of aliases) {
      lookup.set(normalizeHeader(alias), canonicalKey);
    }
  }

  return (header: string): string => {
    const trimmed = header.trim();
    const normalized = normalizeHeader(trimmed);
    return lookup.get(normalized) ?? trimmed;
  };
}

/**
 * Parses CSV content with permissive header mapping and whitespace trimming.
 */
export function parseCsv<T = Record<string, any>>(
  csvData: string,
  aliasMap?: Record<string, string[]>,
): Papa.ParseResult<T> {
  const transformHeader = aliasMap ? createHeaderTransformer(aliasMap) : (h: string) => h.trim();
  const parsed = Papa.parse<T>(csvData, {
    header: true,
    skipEmptyLines: true,
    transformHeader,
  });

  // Filter out benign UndetectableDelimiter warnings on single-column files
  if (parsed.errors.length > 0) {
    parsed.errors = parsed.errors.filter((e) => e.code !== 'UndetectableDelimiter');
  }

  return parsed;
}

export const BUDGET_ITEM_DELETE_ALIASES: Record<string, string[]> = {
  portalId: [
    'portalId',
    'portal_id',
    'portal id',
    'projectId',
    'project_id',
    'project id',
    'portal',
  ],
  itemId: [
    'itemId',
    'item_id',
    'item id',
    'budgetItemId',
    'budget_item_id',
    'budget item id',
    'lineItemId',
    'line_item_id',
    'line item id',
    'item',
  ],
  budgetId: ['budgetId', 'budget_id', 'budget id', 'budget'],
  accountCode: [
    'accountCode',
    'account_code',
    'account code',
    'account',
    'code',
    'lineItem',
    'line_item',
    'line item',
  ],
  projectName: [
    'projectName',
    'project_name',
    'project name',
    'projectTitle',
    'project_title',
    'project title',
    'project',
  ],
};

export const BUDGET_ITEM_SET_ALIASES: Record<string, string[]> = {
  portalId: [
    'portalId',
    'portal_id',
    'portal id',
    'projectId',
    'project_id',
    'project id',
    'portal',
  ],
  itemId: [
    'itemId',
    'item_id',
    'item id',
    'budgetItemId',
    'budget_item_id',
    'budget item id',
    'lineItemId',
    'line_item_id',
    'line item id',
    'item',
  ],
  budgetId: ['budgetId', 'budget_id', 'budget id', 'budget'],
  accountCode: [
    'accountCode',
    'account_code',
    'account code',
    'account',
    'code',
    'lineItem',
    'line_item',
    'line item',
  ],
  projectName: [
    'projectName',
    'project_name',
    'project name',
    'projectTitle',
    'project_title',
    'project title',
    'project',
  ],
  allowCharges: [
    'allowCharges',
    'allow_charges',
    'allow charges',
    'chargesAllowed',
    'charges_allowed',
    'charges allowed',
  ],
  approvalRequiredForChange: [
    'approvalRequiredForChange',
    'approval_required_for_change',
    'approval required for change',
    'approvalRequired',
    'approval_required',
    'approval required',
    'appReq',
    'app_req',
    'app req',
    'requireApproval',
    'require_approval',
    'require approval',
    'approvalRequiredForChanges',
  ],
  description: ['description', 'desc', 'itemDescription', 'item_description', 'item description'],
};

export const USER_DELETE_ALIASES: Record<string, string[]> = {
  userName: [
    'userName',
    'username',
    'user name',
    'user_name',
    'user-name',
    'user',
    'email',
    'userEmail',
    'user_email',
    'user email',
    'userId',
    'user_id',
    'user id',
    'id',
  ],
};

export const USER_REMOVE_PROJECT_ROLE_ALIASES: Record<string, string[]> = {
  projectName: [
    'projectName',
    'project_name',
    'project name',
    'projectTitle',
    'project_title',
    'project title',
    'project',
  ],
  roleName: ['roleName', 'role_name', 'role name', 'role'],
  userName: [
    'userName',
    'username',
    'user name',
    'user_name',
    'user-name',
    'user',
    'email',
    'userEmail',
    'user_email',
    'user email',
  ],
};

export const USER_REMOVE_PROJECT_ALIASES: Record<string, string[]> = {
  projectName: [
    'projectName',
    'project_name',
    'project name',
    'projectTitle',
    'project_title',
    'project title',
    'project',
  ],
  userName: [
    'userName',
    'username',
    'user name',
    'user_name',
    'user-name',
    'user',
    'email',
    'userEmail',
    'user_email',
    'user email',
  ],
};

export const USER_SET_SSO_ALIASES: Record<string, string[]> = {
  userId: [
    'userId',
    'userid',
    'user_id',
    'user id',
    'user-id',
    'id',
    'userName',
    'username',
    'user name',
    'user_name',
    'user',
  ],
  sso: [
    'sso',
    'ssoEnabled',
    'sso_enabled',
    'sso enabled',
    'singleSignOn',
    'single_sign_on',
    'single sign on',
    'single sign-on',
    'ssoRequired',
    'sso_required',
    'sso required',
    'requireSso',
    'require_sso',
    'require sso',
    'loginAuthentication',
    'login_authentication',
    'login authentication',
  ],
};

export const USER_SET_FIELD_ALIASES: Record<string, string[]> = {
  userId: [
    'userId',
    'userid',
    'user_id',
    'user id',
    'user-id',
    'id',
    'userName',
    'username',
    'user name',
    'user_name',
    'user',
  ],
};
