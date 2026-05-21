import puppeteer from 'puppeteer';
import { Environment, baseurl } from './index.js';

const projectListPath = '/da2/Projects/ProjectList.aspx';

// Selectors for the project list table
const projectRowSelector = 'tr.RowData, tr.AltRowData';
const pagingRowSelector = 'tr.Paging';

/**
 * Scan the current project list page for a project matching projectName.
 * Returns the PortalID GUID string (without curly braces) if found, otherwise null.
 */
async function findPortalIdOnPage(
  page: puppeteer.Page,
  projectName: string,
): Promise<string | null> {
  const rows = await page.$$(projectRowSelector);
  for (const row of rows) {
    // The project name link is the third td; its trimmed text is the project name
    const nameCell = await row.$('td:nth-child(3) a');
    if (!nameCell) continue;
    const text = await nameCell.evaluate((el) => el.textContent?.trim() ?? '');
    if (text === projectName) {
      // Extract PortalID from the href, e.g. /da2/Projects/ProjectDetails.aspx?PortalID={guid}
      const href = await nameCell.evaluate((el) => el.getAttribute('href') ?? '');
      const match = href.match(/PortalID=\{?([^}&]+)\}?/i);
      return match ? (match[1] ?? null) : null;
    }
  }

  return null;
}

/**
 * Find the link element for the next page in the pagination row, if one exists.
 * The current page is rendered as a <span>; other pages are <a> tags.
 * Returns the link for currentPage + 1, or null if we're on the last page.
 */
async function getNextPageLink(
  page: puppeteer.Page,
  currentPage: number,
): Promise<puppeteer.ElementHandle | null> {
  const pagingRow = await page.$(pagingRowSelector);
  if (!pagingRow) return null;

  const nextPageText = String(currentPage + 1);
  const links = await pagingRow.$$('a');
  for (const link of links) {
    const text = await link.evaluate((el) => el.textContent?.trim() ?? '');
    if (text === nextPageText) return link;
  }

  return null;
}

/**
 * Find the PortalID for a project by name, paginating through all pages.
 */
export async function getPortalIdByProjectName(
  page: puppeteer.Page,
  env: Environment,
  projectName: string,
): Promise<string> {
  await page.goto(`https://${env}.${baseurl}${projectListPath}`, { waitUntil: 'networkidle0' });

  let currentPage = 1;
  while (true) {
    const portalId = await findPortalIdOnPage(page, projectName);
    if (portalId) return portalId;

    const nextLink = await getNextPageLink(page, currentPage);
    if (!nextLink) break;

    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), nextLink.click()]);
    currentPage++;
  }

  throw new Error(
    `Project '${projectName}' not found in project list (checked ${currentPage} page(s))`,
  );
}
