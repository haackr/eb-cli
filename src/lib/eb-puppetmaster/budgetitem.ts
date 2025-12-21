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
};

const deleteButtonSelector =
  "#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnDelete";
const confirmButtonSelector =
  "ctl00_ctl00_ContentPlaceHolder1_contentSection_btnYesDelete";

export async function deleteBudgetItem(
  options: deleteBudgetItemArgs
): Promise<void> {
  const { env, cookies, browser, budgetItem } = options;
  const browserInstance =
    browser || (await BrowserManager.getInstance().getBrowser());
  const context = await browserInstance.createBrowserContext();
  const page = await context.newPage();

  try {
    // Set cookies
    await context.setCookie(...cookies);

    // Navigate to the budget item page
    const url = `https://${env}.${baseurl}/da2/Budgets/LineItemDetails.aspx?Mode=Edit&PortalId=${
      budgetItem.projectId
    }&LineItemId=${budgetItem.budgetItemId}${
      budgetItem.budgetId ? `&BudgetId=${budgetItem.budgetId}` : ""
    }`;
    await page.goto(url, { waitUntil: "networkidle0" });

    // Assume there's a delete button with selector, e.g., button[data-action="delete"]
    // This is a placeholder; actual implementation needs to match e-Builder's UI
    const deleteButton = await page.$('button[data-action="delete"]');
    if (deleteButton) {
      await deleteButton.click();
      // Wait for confirmation dialog and confirm
      await page.waitForSelector(".confirmation-dialog");
      const confirmButton = await page.$(".confirmation-dialog button.confirm");
      if (confirmButton) {
        await confirmButton.click();
        // Wait for deletion to complete
        await page.waitForNavigation({ waitUntil: "networkidle0" });
      }
    } else {
      throw new Error("Delete button not found");
    }
  } finally {
    await context.close();
  }
}
