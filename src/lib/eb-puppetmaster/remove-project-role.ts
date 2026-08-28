import puppeteer from 'puppeteer';
import { Environment, baseurl, BrowserManager } from './index.js';
import { getPortalIdByProjectName } from './project.js';

export type RemoveUserFromProjectRoleArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser;
  projectName: string;
  roleName: string;
  userNames: string[];
  dryRun: boolean;
  onUsersProcessed?: (
    users: { userName: string; status: 'success' | 'failed'; message: string }[],
  ) => void;
  refreshCookies?: () => Promise<puppeteer.Cookie[]>;
};

export async function findRemoveButton(
  userFrame: puppeteer.Frame | puppeteer.Page,
): Promise<puppeteer.ElementHandle | null> {
  const selectors = [
    '#btnRoleRemove',
    '#btnRemove',
    '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnRoleRemove',
    '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnRemove',
    'input[type="submit"][value*="Remove" i]',
    'input[type="button"][value*="Remove" i]',
    'button[id*="Remove" i]',
    'input[id*="Remove" i]',
  ];

  for (const selector of selectors) {
    const btn = await userFrame.$(selector);
    if (btn) {
      const isVisible = await btn
        .evaluate((el) => {
          const htmlEl = el as HTMLElement;
          return htmlEl.offsetParent !== null && !htmlEl.hidden;
        })
        .catch(() => false);
      if (isVisible) return btn;
    }
  }

  return null;
}

export async function selectMatchingUsersOnCurrentPage(
  userFrame: puppeteer.Frame | puppeteer.Page,
  requestedKeys: string[],
): Promise<string[]> {
  return await userFrame.evaluate((keys: string[]) => {
    function normalizeName(name: string): string {
      const trimmed = name.trim().toLowerCase();
      if (trimmed.includes(',')) {
        const parts = trimmed
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.length === 2 && parts[0] && parts[1]) {
          return `${parts[1]} ${parts[0]}`;
        }
      } else if (trimmed.includes(' ')) {
        const parts = trimmed.split(/\s+/).filter(Boolean);
        if (parts.length === 2 && parts[0] && parts[1]) {
          return `${parts[1]}, ${parts[0]}`;
        }
      }
      return '';
    }

    // Build fast O(1) lookup map from all variants to canonical key
    const lookup = new Map<string, string>();
    for (const key of keys) {
      const k = key.toLowerCase().trim();
      if (!k) continue;
      if (!lookup.has(k)) lookup.set(k, k);
      const inverted = normalizeName(k);
      if (inverted && !lookup.has(inverted)) lookup.set(inverted, k);
      if (k.includes('@')) {
        const prefix = k.split('@')[0]?.trim();
        if (prefix && !lookup.has(prefix)) lookup.set(prefix, k);
      }
    }

    const matched: string[] = [];
    const rows = Array.from(
      document.querySelectorAll('#grdResults tr.RowData, #grdResults tr.AltRowData'),
    );

    for (const row of rows) {
      const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!checkbox) continue;

      const cellTexts = Array.from(row.querySelectorAll('td'))
        .map((c) => (c.textContent ?? '').toLowerCase().trim())
        .filter(Boolean);

      const rowIdentifiers = new Set<string>();
      for (const text of cellTexts) {
        rowIdentifiers.add(text);
        const norm = normalizeName(text);
        if (norm) rowIdentifiers.add(norm);
        if (text.includes('@')) {
          const prefix = text.split('@')[0]?.trim();
          if (prefix) rowIdentifiers.add(prefix);
        }
      }

      const dataAttrs = [
        checkbox.getAttribute('data-username'),
        checkbox.getAttribute('data-name'),
        checkbox.getAttribute('data-userid'),
      ];
      for (const attr of dataAttrs) {
        if (attr) {
          const text = attr.trim().toLowerCase();
          if (text) {
            rowIdentifiers.add(text);
            const norm = normalizeName(text);
            if (norm) rowIdentifiers.add(norm);
            if (text.includes('@')) {
              const prefix = text.split('@')[0]?.trim();
              if (prefix) rowIdentifiers.add(prefix);
            }
          }
        }
      }

      if (
        checkbox.value &&
        !['on', 'true', 'false'].includes(checkbox.value.toLowerCase()) &&
        !checkbox.value.startsWith('ctl00')
      ) {
        const val = checkbox.value.trim().toLowerCase();
        if (val) rowIdentifiers.add(val);
      }

      let matchedKey: string | undefined;
      for (const id of rowIdentifiers) {
        if (lookup.has(id)) {
          matchedKey = lookup.get(id);
          break;
        }
      }

      if (matchedKey) {
        if (!checkbox.checked) {
          checkbox.click();
        }
        if (checkbox.checked) {
          matched.push(matchedKey);
          lookup.delete(matchedKey);
          const inv = normalizeName(matchedKey);
          if (inv) lookup.delete(inv);
          if (matchedKey.includes('@')) {
            const prefix = matchedKey.split('@')[0]?.trim();
            if (prefix) lookup.delete(prefix);
          }
        }
      }
    }

    return matched;
  }, requestedKeys);
}

/**
 * Remove one or more users from a project role.
 * Groups by project/role so all users can be selected before triggering a single remove action.
 */
export async function removeUserFromProjectRoleByName(
  options: RemoveUserFromProjectRoleArgs,
): Promise<{ notFound: string[]; removed: string[] }> {
  const {
    env,
    cookies,
    browser,
    projectName,
    roleName,
    userNames,
    dryRun,
    onUsersProcessed,
    refreshCookies,
  } = options;
  const browserInstance = browser || (await BrowserManager.getInstance().getBrowser());

  if (!browserInstance.connected) {
    throw new Error('Browser is not connected');
  }

  const requestedByKey = new Map<string, string>();
  for (const userName of userNames) {
    const key = userName.trim().toLowerCase();
    if (key && !requestedByKey.has(key)) {
      requestedByKey.set(key, userName);
    }
  }

  const matchedKeys = new Set<string>();
  const remainingKeys = () => Array.from(requestedByKey.keys()).filter((k) => !matchedKeys.has(k));

  let currentCookies = cookies;
  let lastRefreshTime = Date.now();

  const context = browserInstance.defaultBrowserContext();
  let page: puppeteer.Page | null = null;

  async function createAndInitPage(): Promise<puppeteer.Page> {
    if (page && !page.isClosed()) {
      try {
        await page.close();
      } catch {}
    }
    await context.setCookie(...currentCookies);
    const newP = await context.newPage();
    newP.setDefaultNavigationTimeout(90_000);
    newP.setDefaultTimeout(90_000);

    newP.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {}
    });

    const portalId = await getPortalIdByProjectName(newP, env, projectName);
    const roleMgmtUrl = `https://${env}.${baseurl}/da2/Projects/ProjectParticipants.aspx?PortalID={${portalId}}`;
    await newP.goto(roleMgmtUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const roleListFrameEl = await newP.waitForSelector(
      'iframe#RAD_SPLITTER_PANE_EXT_CONTENT_ctl00_ctl00_ContentPlaceHolder1_contentSection_groupList, iframe[name*="groupList"]',
      { timeout: 90_000 },
    );
    if (!roleListFrameEl) throw new Error('Role list iframe not found');
    const roleFrame = await roleListFrameEl.contentFrame();
    if (!roleFrame) throw new Error('Could not access role list iframe content');

    await roleFrame.waitForSelector('#dgAccountRoles, table', { timeout: 90_000 });

    const targetRoleNameNorm = roleName.trim().toLowerCase();
    const roleLinks = await roleFrame.$$(
      '#dgAccountRoles a[name="selectedGroup"], #dgAccountRoles a, table a',
    );
    let roleLink: puppeteer.ElementHandle | null = null;
    for (const link of roleLinks) {
      const text = await link.evaluate((el) => el.textContent?.trim() ?? '');
      if (text.toLowerCase() === targetRoleNameNorm) {
        roleLink = link;
        break;
      }
    }
    if (!roleLink) throw new Error(`Role '${roleName}' not found in project '${projectName}'`);

    await Promise.all([
      newP.waitForNetworkIdle({ idleTime: 500, timeout: 30_000 }).catch(() => null),
      roleLink.click(),
    ]);

    return newP;
  }

  async function getUserFrame(activePage: puppeteer.Page): Promise<puppeteer.Frame> {
    const userListFrameEl = await activePage.waitForSelector(
      'iframe#RAD_SPLITTER_PANE_EXT_CONTENT_ctl00_ctl00_ContentPlaceHolder1_contentSection_userList, iframe[name*="userList"]',
      { timeout: 90_000 },
    );
    if (!userListFrameEl) throw new Error('User list iframe not found');
    const userFrame = await userListFrameEl.contentFrame();
    if (!userFrame) throw new Error('Could not access user list iframe content');
    return userFrame;
  }

  const maxAttempts = 3;
  let attempt = 0;

  try {
    while (attempt < maxAttempts && remainingKeys().length > 0) {
      attempt++;
      try {
        page = await createAndInitPage();
        let userFrame = await getUserFrame(page);
        await userFrame.waitForSelector('#grdResults, table', { timeout: 90_000 });

        let cycleCount = 0;
        while (remainingKeys().length > 0) {
          cycleCount++;
          // Periodic session cookie refresh to prevent session expiration during huge batches
          if (
            refreshCookies &&
            (Date.now() - lastRefreshTime > 5 * 60_000 || cycleCount % 20 === 0)
          ) {
            try {
              currentCookies = await refreshCookies();
              await context.setCookie(...currentCookies);
              lastRefreshTime = Date.now();
            } catch {}
          }

          userFrame = await getUserFrame(page);
          const currentMatched = await selectMatchingUsersOnCurrentPage(userFrame, remainingKeys());

          if (currentMatched.length > 0) {
            const batchMatchedOriginals: string[] = [];
            for (const k of currentMatched) {
              matchedKeys.add(k);
              const orig = requestedByKey.get(k) || k;
              batchMatchedOriginals.push(orig);
            }

            if (!dryRun) {
              const removeBtn = await findRemoveButton(userFrame);
              if (!removeBtn) {
                throw new Error('Remove button not found in user list iframe');
              }

              await Promise.all([
                page.waitForNetworkIdle({ idleTime: 500, timeout: 60_000 }).catch(() => null),
                removeBtn.click(),
              ]);

              userFrame = await getUserFrame(page);
              await userFrame
                .waitForSelector('#grdResults, table', { timeout: 60_000 })
                .catch(() => null);
            }

            if (onUsersProcessed) {
              onUsersProcessed(
                batchMatchedOriginals.map((userName) => ({
                  userName,
                  status: 'success',
                  message: dryRun ? 'Dry run' : 'Removed',
                })),
              );
            }

            if (!dryRun && remainingKeys().length > 0) {
              continue;
            }
          }

          if (remainingKeys().length === 0) {
            break;
          }

          // Check if there is a next page in the grid
          const nextGridLink = await userFrame.evaluateHandle(() => {
            const pagingRow = document.querySelector('#grdResults tr.Paging, tr.Paging');
            if (!pagingRow) return null;

            const currentSpan = pagingRow.querySelector('span');
            const currentPageNum = currentSpan
              ? parseInt(currentSpan.textContent?.trim() || '1', 10)
              : 1;
            const targetPageNum = String(currentPageNum + 1);

            const links = Array.from(pagingRow.querySelectorAll('a'));
            return (
              links.find((a) => a.textContent?.trim() === targetPageNum) ||
              links.find((a) => (a.textContent ?? '').toLowerCase().includes('next')) ||
              null
            );
          });

          const nextLinkEl = nextGridLink.asElement();
          if (!nextLinkEl) {
            await nextGridLink.dispose().catch(() => {});
            break;
          }

          await Promise.all([
            page.waitForNetworkIdle({ idleTime: 500, timeout: 30_000 }).catch(() => null),
            (nextLinkEl as puppeteer.ElementHandle<HTMLElement>).click(),
          ]);
          await nextGridLink.dispose().catch(() => {});

          userFrame = await getUserFrame(page);
          await userFrame.waitForSelector('#grdResults, table', { timeout: 30_000 });
        }

        // Successfully reached end of pages or found all remaining keys
        break;
      } catch (err) {
        if (attempt >= maxAttempts || remainingKeys().length === 0) {
          throw err;
        }
        // Attempt recovery on transient error / session drop
        if (refreshCookies) {
          try {
            currentCookies = await refreshCookies();
            lastRefreshTime = Date.now();
          } catch {}
        }
      }
    }

    const notFound: string[] = [];
    const removed: string[] = [];

    for (const [key, originalUserName] of requestedByKey.entries()) {
      if (matchedKeys.has(key)) {
        removed.push(originalUserName);
      } else {
        notFound.push(originalUserName);
      }
    }

    if (onUsersProcessed && notFound.length > 0) {
      onUsersProcessed(
        notFound.map((userName) => ({
          userName,
          status: 'success',
          message: 'Not found (skipped)',
        })),
      );
    }

    return { notFound, removed };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {}
    }
  }
}
