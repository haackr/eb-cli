import { Environment, baseurl } from './index.js';
import { detectLoginPage, sessionCheckErrorFor } from './session-check.js';

const projectListPath = '/da2/Projects/ProjectList.aspx';

// Selectors for the project list table
const pagingRowSelector = 'tr.Paging';

// In-memory cache for PortalIDs by normalized project name and site origin
const projectPortalIdCache = new Map<string, string>();
// Names that appear more than once with different PortalIDs, keyed like the cache
const ambiguousProjects = new Map<string, Set<string>>();

function getCacheKey(origin: string, projectName: string): string {
  return `${origin}:${projectName.trim().toLowerCase()}`;
}

export function clearProjectCache(): void {
  projectPortalIdCache.clear();
  ambiguousProjects.clear();
}

/** Returns the cached PortalID, throwing when several projects share the name. */
function cachedPortalId(cacheKey: string, projectName: string): string | undefined {
  const ids = ambiguousProjects.get(cacheKey);
  if (ids) {
    throw new Error(
      `Several projects are named '${projectName}'; pass the PortalID instead (${[...ids].join(', ')})`,
    );
  }
  return projectPortalIdCache.get(cacheKey);
}

/**
 * Scan the current project list page and extract all project names and PortalIDs.
 * Populates the in-memory cache with all discovered projects.
 */
async function extractAndCacheProjectsOnPage(
  page: puppeteer.Page,
  origin: string,
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
    const key = getCacheKey(origin, proj.name);
    const existing = projectPortalIdCache.get(key);
    if (existing && existing.toLowerCase() !== proj.portalId.toLowerCase()) {
      const ids = ambiguousProjects.get(key) ?? new Set([existing]);
      ids.add(proj.portalId);
      ambiguousProjects.set(key, ids);
    }
    projectPortalIdCache.set(key, proj.portalId);
  }

  return projects;
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
 * Find the PortalID for a project by name, checking cache and paginating through pages as needed.
 */
export async function getPortalIdByProjectName(
  page: puppeteer.Page,
  env: Environment,
  projectName: string,
): Promise<string> {
  return await getPortalIdByProjectNameAtOrigin(page, `https://${env}.${baseurl}`, projectName);
}

/**
 * Same as getPortalIdByProjectName, for callers that have the site origin
 * (e.g. "https://app-us2.e-builder.net") rather than an Environment.
 *
 * Reads the Manage Projects list (ProjectList.aspx), which includes hidden projects.
 * Name matching is exact and case-insensitive.
 */
export async function getPortalIdByProjectNameAtOrigin(
  page: puppeteer.Page,
  origin: string,
  projectName: string,
): Promise<string> {
  const cacheKey = getCacheKey(origin, projectName);
  const cached = cachedPortalId(cacheKey, projectName);
  if (cached) {
    return cached;
  }

  await page.goto(`${origin}${projectListPath}`, {
    waitUntil: 'domcontentloaded',
  });
  if (await detectLoginPage(page)) {
    throw sessionCheckErrorFor({ reason: 'redirected_to_login', landedUrl: page.url() }, origin);
  }

  let currentPage = 1;
  while (true) {
    await extractAndCacheProjectsOnPage(page, origin);

    const foundPortalId = cachedPortalId(cacheKey, projectName);
    if (foundPortalId) {
      return foundPortalId;
    }

    const nextLink = await getNextPageLink(page, currentPage);
    if (!nextLink) break;

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      nextLink.click(),
    ]);
    currentPage++;
  }

  throw new Error(
    `Project '${projectName}' not found in project list (checked ${currentPage} page(s))`,
  );
}
