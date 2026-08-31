import { type Page, type ElementHandle } from 'playwright';
import { Environment, baseurl } from './index.js';

const projectListPath = '/da2/Projects/ProjectList.aspx';

// Selectors for the project list table
const pagingRowSelector = 'tr.Paging';

// In-memory cache for PortalIDs by normalized project name and environment
const projectPortalIdCache = new Map<string, string>();

function getCacheKey(env: Environment, projectName: string): string {
  return `${env}:${projectName.trim().toLowerCase()}`;
}

export function clearProjectCache(): void {
  projectPortalIdCache.clear();
}

/**
 * Scan the current project list page and extract all project names and PortalIDs.
 * Populates the in-memory cache with all discovered projects.
 */
async function extractAndCacheProjectsOnPage(
  page: Page,
  env: Environment,
): Promise<{ name: string; portalId: string }[]> {
  const projects = await page.evaluate(() => {
    const rows = document.querySelectorAll('tr.RowData, tr.AltRowData');
    const result: { name: string; portalId: string }[] = [];
    for (const row of Array.from(rows)) {
      const a = row.querySelector('td:nth-child(3) a') as HTMLAnchorElement | null;
      if (!a) continue;
      const name = a.textContent?.trim() ?? '';
      const href = a.getAttribute('href') ?? '';
      const match = href.match(/PortalID=\{?([^}&]+)\}?/i);
      if (name && match?.[1]) {
        result.push({ name, portalId: match[1] });
      }
    }
    return result;
  });

  for (const proj of projects) {
    projectPortalIdCache.set(getCacheKey(env, proj.name), proj.portalId);
  }

  return projects;
}

/**
 * Find the link element for the next page in the pagination row, if one exists.
 * The current page is rendered as a <span>; other pages are <a> tags.
 * Returns the link for currentPage + 1, or null if we're on the last page.
 */
async function getNextPageLink(page: Page, currentPage: number): Promise<ElementHandle | null> {
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
 * Find the PortalID for a project by name, checking cache and paginating through pages as needed.
 */
export async function getPortalIdByProjectName(
  page: Page,
  env: Environment,
  projectName: string,
): Promise<string> {
  const cacheKey = getCacheKey(env, projectName);
  const cachedPortalId = projectPortalIdCache.get(cacheKey);
  if (cachedPortalId) {
    return cachedPortalId;
  }

  await page.goto(`https://${env}.${baseurl}${projectListPath}`, {
    waitUntil: 'domcontentloaded',
  });

  let currentPage = 1;
  while (true) {
    await extractAndCacheProjectsOnPage(page, env);

    const foundPortalId = projectPortalIdCache.get(cacheKey);
    if (foundPortalId) {
      return foundPortalId;
    }

    const nextLink = await getNextPageLink(page, currentPage);
    if (!nextLink) break;

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => null),
      nextLink.click(),
    ]);
    currentPage++;
  }

  throw new Error(
    `Project '${projectName}' not found in project list (checked ${currentPage} page(s))`,
  );
}
