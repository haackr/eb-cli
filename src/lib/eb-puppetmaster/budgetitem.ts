import puppeteer from "puppeteer";
import { Environment, baseurl, BrowserManager } from "./index.js";

export type BudgetItem = {
  budgetItemId: string;
  accountCode?: string;
  projectName?: string;
  projectId?: string;
  budgetId?: string;
  allowCharges?: boolean;
  approvalRequiredForChange?: boolean;
};

type deleteBudgetItemArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser;
  budgetItem: BudgetItem;
  dryRun: boolean;
};

const deleteButtonSelector =
  "#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnDelete";
const confirmButtonSelector =
  "ctl00_ctl00_ContentPlaceHolder1_contentSection_btnYesDelete";

export async function deleteBudgetItem(
  options: deleteBudgetItemArgs
): Promise<void> {
  const { env, cookies, browser, budgetItem, dryRun = false } = options;
  const browserInstance =
    browser || (await BrowserManager.getInstance().getBrowser());

  let page: puppeteer.Page | null = null;

  try {
    // Check if browser is still connected
    if (!browserInstance.connected) {
      throw new Error("Browser is not connected");
    }

    // Use default context instead of creating a new one
    const context = browserInstance.defaultBrowserContext();

    // Set cookies on the default context
    await context.setCookie(...cookies);

    // Create a new page
    page = await browserInstance.newPage();

    // Set cookies on the page as well (redundant but safe)
    await page.setCookie(...cookies);

    // Navigate to the budget item page
    const url = `https://${env}.${baseurl}/da2/Cost/Budgets/LineItemDetails.aspx?Mode=Edit&PortalID=${
      budgetItem.projectId
    }&BudgetLineItemId=${budgetItem.budgetItemId}${
      budgetItem.budgetId ? `&BudgetId=${budgetItem.budgetId}` : ""
    }`;
    await page.goto(url, { waitUntil: "networkidle0" });

    // Assume there's a delete button with selector, e.g., button[data-action="delete"]
    // This is a placeholder; actual implementation needs to match e-Builder's UI
    const deleteButton = await page.waitForSelector(deleteButtonSelector);
    if (deleteButton) {
      await deleteButton.click();
      // Wait for confirmation dialog and confirm
      const confirmButton = await page.waitForSelector(confirmButtonSelector, {
        visible: true,
      });
      if (confirmButton && !dryRun) {
        await confirmButton.click();
        // Wait for deletion to complete
        await page.waitForNavigation({ waitUntil: "networkidle0" });
      }
    } else {
      throw new Error("Delete button not found");
    }
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (error) {
        // Ignore errors during page close
      }
    }
  }
}
