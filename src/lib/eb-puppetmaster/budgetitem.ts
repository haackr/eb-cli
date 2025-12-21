import puppeteer from "puppeteer";
import { Environment, baseurl, BrowserManager } from "./index.js";

export type BudgetItem = {
  budgetItemId: string;
  accountCode: string;
  projectName?: string;
  projectId: string;
  budgetId: string;
  allowCharges?: boolean;
  approvalRequiredForChange?: boolean;
};

type deleteBudgetItemArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser;
  budgetItem: BudgetItem;
};

export async function deleteBudgetItem(
  options: deleteBudgetItemArgs
): Promise<void> {}
