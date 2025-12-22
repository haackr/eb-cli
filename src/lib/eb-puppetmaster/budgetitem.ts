import puppeteer from 'puppeteer';
import { Environment, baseurl, BrowserManager } from './index.js';

export type BudgetItem = {
  budgetItemId: string;
  accountCode?: string;
  projectName?: string;
  projectId: string;
  budgetId?: string;
  allowCharges?: boolean;
  approvalRequiredForChange?: boolean;
  description?: string;
};

type deleteBudgetItemArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser;
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

export async function deleteBudgetItem(options: deleteBudgetItemArgs): Promise<void> {
  const { env, cookies, browser, budgetItem, dryRun = false } = options;
  const browserInstance = browser || (await BrowserManager.getInstance().getBrowser());

  let page: puppeteer.Page | null = null;

  try {
    // Check if browser is still connected
    if (!browserInstance.connected) {
      throw new Error('Browser is not connected');
    }

    // Use default context instead of creating a new one
    const context = browserInstance.defaultBrowserContext();

    // Set cookies on the default context
    await context.setCookie(...cookies);

    // Create a new page
    page = await browserInstance.newPage();

    // Set cookies on the page as well (redundant but safe)
    await context.setCookie(...cookies);

    // Navigate to the budget item page
    const url = `https://${env}.${baseurl}/da2/Cost/Budgets/LineItemDetails.aspx?Mode=Edit&PortalID=${
      budgetItem.projectId
    }&BudgetLineItemId=${budgetItem.budgetItemId}${
      budgetItem.budgetId ? `&BudgetId=${budgetItem.budgetId}` : ''
    }`;
    await page.goto(url, { waitUntil: 'networkidle0' });

    const deleteButton = await page.$(deleteButtonSelector);
    if (deleteButton) {
      await deleteButton.click();
      await page.waitForNavigation();
      // Wait for confirmation dialog and confirm
      const confirmButton = await page.waitForSelector(confirmButtonSelector);
      if (confirmButton && !dryRun) {
        await confirmButton.click();
        // Wait for deletion to complete
        await page.waitForNavigation({ waitUntil: 'networkidle0' });
      }
    } else {
      throw new Error('Delete button not found');
    }
  } finally {
    if (page) {
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
  browser?: puppeteer.Browser;
  budgetItem: BudgetItem;
  dryRun?: boolean;
};

export async function setBudgetItemProperties(options: SetBudgetItemPropertiesArgs): Promise<void> {
  const { env, cookies, browser, budgetItem, dryRun = false } = options;
  const browserInstance = browser || (await BrowserManager.getInstance().getBrowser());
  let page: puppeteer.Page | null = null;
  try {
    const context = browserInstance.defaultBrowserContext();
    await context.setCookie(...cookies);
    page = await context.newPage();
    const url = `https://${env}.${baseurl}/da2/Cost/Budgets/AddEditLineItem.aspx?PortalId=${
      budgetItem.projectId
    }&BudgetLineItemId=${budgetItem.budgetItemId}${
      budgetItem.budgetId ? `&BudgetId=${budgetItem.budgetId}` : ''
    }&mode=Edit`;
    await page.goto(url, { waitUntil: 'networkidle0' });

    // Set properties
    if (budgetItem.allowCharges !== undefined) {
      const allowChargesCheckbox = await page.waitForSelector(allowChargesSelector);
      if (!allowChargesCheckbox) throw new Error('Allow Charges checkbox not found');
      const allowChargesChecked = await (
        await allowChargesCheckbox?.getProperty('checked')
      ).jsonValue();
      if (allowChargesChecked !== budgetItem.allowCharges) {
        await allowChargesCheckbox.click();
      }
    }

    if (budgetItem.approvalRequiredForChange !== undefined) {
      const approvalCheckbox = await page.waitForSelector(approvalRequiredForChangeSelector);
      if (!approvalCheckbox) throw new Error('Approval Required for Change checkbox not found');
      const approvalChecked = await (await approvalCheckbox?.getProperty('checked')).jsonValue();
      if (approvalChecked !== budgetItem.approvalRequiredForChange) {
        await approvalCheckbox.click();
      }
    }

    if (budgetItem.description) {
      const descriptionInput = await page.waitForSelector(descriptionSelector);
      if (!descriptionInput) throw new Error('Description input not found');
      await page.$eval(
        descriptionSelector,
        (el, value) => {
          (el as HTMLInputElement).value = String(value ?? '');
        },
        budgetItem.description,
      );
    }
    await page.waitForNetworkIdle();
    // Save changes
    if (!dryRun) {
      const saveButton = await page.$(saveButtonSelector);
      if (!saveButton) throw new Error('Save button not found');
      await saveButton.click();
      await page.waitForNavigation({ waitUntil: 'networkidle0' });
    }
  } finally {
    if (page) {
      page.close();
    }
  }
}
