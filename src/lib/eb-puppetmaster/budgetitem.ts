import { Environment, baseurl, BrowserManager, optimizePageForAutomation } from './index.js';
import { getPortalIdByProjectName } from './project.js';

export type BudgetItem = {
  budgetItemId: string;
  accountCode?: string | undefined;
  projectName?: string | undefined;
  projectId: string;
  budgetId?: string | undefined;
  allowCharges?: boolean | undefined;
  approvalRequiredForChange?: boolean | undefined;
  description?: string | undefined;
};

type deleteBudgetItemArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser | undefined;
  page?: puppeteer.Page | undefined;
  budgetItem: BudgetItem;
  dryRun: boolean;
};

const deleteButtonSelector = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnDelete';
const confirmButtonSelector = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnYesDelete';
const allowChargesSelector = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_chkAllowCharges';
const approvalRequiredForChangeSelector =
  '#ctl00_ctl00_ContentPlaceHolder1_contentSection_chkAppReq';
const descriptionSelector = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_tbDescription';
const saveButtonSelector = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnSave';
const editButtonSelector = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnEditDetails';

const summaryGridSelector = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_grdSummary_ctl00';
const hideZeroValuesCheckboxSelector =
  '#ctl00_ctl00_ContentPlaceHolder1_contentSection_chkHideZeroValues';

// In-memory cache for budget item IDs: key = `${env}:${cleanPortalId}`, value = Map<normalizedAccountCode, itemId>
const projectBudgetItemsCache = new Map<string, Map<string, string>>();

function getBudgetItemCacheKey(env: Environment, portalId: string): string {
  const cleanPortalId = portalId.replace(/[{}]/g, '').trim().toLowerCase();
  return `${env}:${cleanPortalId}`;
}

export function clearBudgetItemCache(): void {
  projectBudgetItemsCache.clear();
}

/**
 * Navigates to a project's cost summary page, unchecks zero-value hiding if necessary,
 * and extracts all account codes and their corresponding budget item IDs.
 */
export async function fetchProjectBudgetItems(
  page: puppeteer.Page,
  env: Environment,
  portalId: string,
): Promise<Map<string, string>> {
  const cacheKey = getBudgetItemCacheKey(env, portalId);
  const cached = projectBudgetItemsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const cleanPortalId = portalId.replace(/[{}]/g, '').trim();
  const summaryUrl = `https://${env}.${baseurl}/da2/Cost/ProjectCostSummary.aspx?PortalID={${cleanPortalId}}`;
  await page.goto(summaryUrl, { waitUntil: 'domcontentloaded' });

  // Ensure hide zero values is unchecked so zero value lines are visible
  const hideZeroCheckbox = await page.$(hideZeroValuesCheckboxSelector);
  if (hideZeroCheckbox) {
    const isChecked = await (await hideZeroCheckbox.getProperty('checked')).jsonValue();
    if (isChecked) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => null),
        hideZeroCheckbox.click(),
      ]);
    }
  }

  await page.waitForSelector(summaryGridSelector, { timeout: 30_000 });

  const extracted = await page.evaluate((tableSelector) => {
    const table = document.querySelector(tableSelector);
    if (!table) return [];
    const links = Array.from(table.querySelectorAll('a[onclick*="LI("]'));
    const results: { accountCode: string; itemId: string }[] = [];
    for (const a of links) {
      const text = (a.textContent ?? '').trim();
      const onclick = a.getAttribute('onclick') ?? '';
      const match = onclick.match(/LI\(["']?([^"')]+)["']?\)/i);
      if (text && match?.[1]) {
        results.push({ accountCode: text, itemId: match[1].trim() });
      }
    }
    return results;
  }, summaryGridSelector);

  const itemMap = new Map<string, string>();
  for (const item of extracted) {
    itemMap.set(item.accountCode.toLowerCase().trim(), item.itemId);
  }
  projectBudgetItemsCache.set(cacheKey, itemMap);
  return itemMap;
}

export type ResolveBudgetItemArgs = {
  page: puppeteer.Page;
  env: Environment;
  portalId?: string | undefined;
  projectName?: string | undefined;
  itemId?: string | undefined;
  accountCode?: string | undefined;
};

/**
 * Resolves portalId (from projectName if needed) and itemId (from accountCode if needed).
 */
export async function resolveBudgetItemIdentifiers(
  options: ResolveBudgetItemArgs,
): Promise<{ portalId: string; itemId: string }> {
  const { page, env, projectName, accountCode } = options;
  let { portalId, itemId } = options;

  // 1. Resolve portalId if missing
  if (!portalId) {
    if (!projectName) {
      throw new Error('Neither Project ID (portalId) nor Project Name was provided');
    }
    portalId = await getPortalIdByProjectName(page, env, projectName);
  }

  // 2. Resolve itemId if missing
  if (!itemId) {
    if (!accountCode) {
      throw new Error('Neither Item ID nor Account Code was provided');
    }
    const itemMap = await fetchProjectBudgetItems(page, env, portalId);
    const foundItemId = itemMap.get(accountCode.toLowerCase().trim());
    if (!foundItemId) {
      throw new Error(
        `Account code '${accountCode}' not found in project ${
          projectName ? `'${projectName}' ` : ''
        }(PortalID: ${portalId})`,
      );
    }
    itemId = foundItemId;
  }

  return { portalId, itemId };
}

export async function deleteBudgetItem(options: deleteBudgetItemArgs): Promise<void> {
  const { env, cookies, browser, budgetItem, dryRun = false } = options;
  let page: puppeteer.Page | null = options.page ?? null;
  let ownPage = false;
  const browserInstance =
    browser || (page ? page.browser() : await BrowserManager.getInstance().getBrowser());

  try {
    // Check if browser is still connected
    if (!browserInstance.connected) {
      throw new Error('Browser is not connected');
    }

    const context = browserInstance.defaultBrowserContext();
    await context.setCookie(...cookies);

    if (!page) {
      page = await browserInstance.newPage();
      ownPage = true;
      await optimizePageForAutomation(page);
    }

    // Navigate to the budget item page
    const cleanPortalId = budgetItem.projectId.replace(/[{}]/g, '').trim();
    const url = `https://${env}.${baseurl}/da2/Cost/Budgets/LineItemDetails.aspx?Mode=Edit&PortalID={${cleanPortalId}}&BudgetLineItemId=${
      budgetItem.budgetItemId
    }${budgetItem.budgetId ? `&BudgetId=${budgetItem.budgetId}` : ''}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const deleteButton = await page.waitForSelector(deleteButtonSelector, { timeout: 30_000 });
    if (deleteButton) {
      if (typeof deleteButton.click === 'function') {
        await Promise.all([
          page
            .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 })
            .catch(() => null),
          deleteButton.click(),
        ]);
      }
      // Wait for confirmation dialog and confirm
      const confirmButton = await page.waitForSelector(confirmButtonSelector, { timeout: 30_000 });
      if (confirmButton && !dryRun && typeof confirmButton.click === 'function') {
        await Promise.all([
          page
            .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 })
            .catch(() => null),
          confirmButton.click(),
        ]);
      }
    } else {
      throw new Error('Delete button not found');
    }
  } finally {
    if (ownPage && page) {
      try {
        await page.close();
      } catch {
        // Ignore errors during page close
      }
    }
  }
}

type SetBudgetItemPropertiesArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser | undefined;
  page?: puppeteer.Page | undefined;
  budgetItem: BudgetItem;
  dryRun?: boolean | undefined;
};

export async function setBudgetItemProperties(options: SetBudgetItemPropertiesArgs): Promise<void> {
  const { env, cookies, browser, budgetItem, dryRun = false } = options;
  let page: puppeteer.Page | null = options.page ?? null;
  let ownPage = false;
  const browserInstance =
    browser || (page ? page.browser() : await BrowserManager.getInstance().getBrowser());

  try {
    const context = browserInstance.defaultBrowserContext();
    await context.setCookie(...cookies);
    if (!page) {
      page = await context.newPage();
      ownPage = true;
      await optimizePageForAutomation(page);
    }
    const cleanPortalId = budgetItem.projectId.replace(/[{}]/g, '').trim();
    const url = `https://${env}.${baseurl}/da2/Cost/Budgets/LineItemDetails.aspx?Mode=Edit&PortalId={${cleanPortalId}}&BudgetLineItemId=${
      budgetItem.budgetItemId
    }${budgetItem.budgetId ? `&BudgetId=${budgetItem.budgetId}` : ''}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const editButton = await page.waitForSelector(editButtonSelector, { timeout: 30_000 });
    await editButton?.click();
    // Set properties
    if (budgetItem.allowCharges !== undefined) {
      const allowChargesCheckbox = await page.waitForSelector(allowChargesSelector, {
        timeout: 30_000,
      });
      if (!allowChargesCheckbox) throw new Error('Allow Charges checkbox not found');
      const allowChargesChecked = await (
        await allowChargesCheckbox?.getProperty('checked')
      ).jsonValue();
      if (allowChargesChecked !== budgetItem.allowCharges) {
        await allowChargesCheckbox.click();
      }
    }

    if (budgetItem.approvalRequiredForChange !== undefined) {
      const approvalCheckbox = await page.waitForSelector(approvalRequiredForChangeSelector, {
        timeout: 30_000,
      });
      if (!approvalCheckbox) throw new Error('Approval Required for Change checkbox not found');
      const approvalChecked = await (await approvalCheckbox?.getProperty('checked')).jsonValue();
      if (approvalChecked !== budgetItem.approvalRequiredForChange) {
        await approvalCheckbox.click();
      }
    }

    if (budgetItem.description) {
      const descriptionInput = await page.waitForSelector(descriptionSelector, { timeout: 30_000 });
      if (!descriptionInput) throw new Error('Description input not found');
      await page.$eval(
        descriptionSelector,
        (el, value) => {
          (el as HTMLInputElement).value = String(value ?? '');
        },
        budgetItem.description,
      );
    }

    // Save changes
    if (!dryRun) {
      const saveButton = await page.$(saveButtonSelector);
      if (!saveButton) throw new Error('Save button not found');
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 })
          .catch(() => null),
        saveButton.click(),
      ]);
    }
  } finally {
    if (ownPage && page) {
      try {
        await page.close();
      } catch {}
    }
  }
}
