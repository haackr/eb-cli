import { Environment, baseurl, BrowserManager } from './index.js';
import { getPortalIdByProjectName } from './project.js';

export type RemoveUserFromProjectArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser;
  projectName: string;
  userNames: string[];
  dryRun: boolean;
};

export async function selectUsersInProjectGrid(
  userFrame: puppeteer.Frame | puppeteer.Page,
  keys: string[],
): Promise<string[]> {
  return await userFrame.evaluate((keys: string[]) => {
    const requested = new Set(keys);
    const matched: string[] = [];
    const rows = Array.from(
      document.querySelectorAll('#grdResults tr.RowData, #grdResults tr.AltRowData'),
    );

    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      const usernameCell = cells.item(2);
      if (!usernameCell) continue;

      const key = (usernameCell.textContent ?? '').trim().toLowerCase();
      if (!requested.has(key)) continue;

      const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!checkbox) continue;

      if (!checkbox.checked) {
        checkbox.click();
      }

      if (checkbox.checked) {
        matched.push(key);
      }
    }

    return matched;
  }, keys);
}

/**
 * Remove one or more users directly from a project's participant list.
 */
export async function removeUserFromProjectByName(
  options: RemoveUserFromProjectArgs,
): Promise<{ notFound: string[] }> {
  const { env, cookies, browser, projectName, userNames, dryRun } = options;
  const browserInstance = browser || (await BrowserManager.getInstance().getBrowser());

  let page: puppeteer.Page | null = null;
  try {
    if (!browserInstance.connected) {
      throw new Error('Browser is not connected');
    }

    const context = browserInstance.defaultBrowserContext();
    await context.setCookie(...cookies);
    page = await context.newPage();

    // 1. Find the project's PortalID from the project list
    const portalId = await getPortalIdByProjectName(page, env, projectName);

    // 2. Navigate to the project participants page
    const projectParticipantsUrl = `https://${env}.${baseurl}/da2/Projects/ProjectParticipants.aspx?PortalID={${portalId}}`;
    await page.goto(projectParticipantsUrl, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 2000));

    // 3. Helper to get the user list iframe
    async function getUserFrame(): Promise<puppeteer.Frame> {
      const userListFrameEl = await page!.waitForSelector(
        'iframe#RAD_SPLITTER_PANE_EXT_CONTENT_ctl00_ctl00_ContentPlaceHolder1_contentSection_userList, iframe[name*="userList"]',
        { timeout: 30_000 },
      );
      if (!userListFrameEl) throw new Error('User list iframe not found');
      const uFrame = await userListFrameEl.contentFrame();
      if (!uFrame) throw new Error('Could not access user list iframe content');
      return uFrame;
    }

    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {}
    });

    let userFrame = await getUserFrame();
    await userFrame.waitForSelector('#grdResults, table', { timeout: 30_000 });

    // 4. Select checkboxes for matching users across grid pages.
    const requestedByKey = new Map<string, string>();
    for (const userName of userNames) {
      const key = userName.trim().toLowerCase();
      if (!requestedByKey.has(key)) requestedByKey.set(key, userName);
    }

    const matchedKeys = new Set<string>();
    const remainingKeys = () =>
      Array.from(requestedByKey.keys()).filter((k) => !matchedKeys.has(k));

    while (true) {
      userFrame = await getUserFrame();
      const currentMatched = await selectUsersInProjectGrid(userFrame, remainingKeys());
      if (currentMatched.length > 0) {
        for (const k of currentMatched) matchedKeys.add(k);

        if (!dryRun) {
          const removeBtn = await userFrame.waitForSelector('#btnRemove');
          if (!removeBtn) throw new Error('Remove from Project button not found');
          await removeBtn.click();
          await new Promise((r) => setTimeout(r, 2000));
          userFrame = await getUserFrame();
          await userFrame
            .waitForSelector('#grdResults, table', { timeout: 20_000 })
            .catch(() => null);
          if (remainingKeys().length > 0) {
            continue;
          }
        }
      }

      if (remainingKeys().length === 0) break;

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
      if (!nextLinkEl) break;

      await Promise.all([
        page.waitForNetworkIdle({ idleTime: 500, timeout: 15_000 }).catch(() => null),
        (nextLinkEl as puppeteer.ElementHandle<HTMLElement>).click(),
      ]);

      userFrame = await getUserFrame();
      await userFrame.waitForSelector('#grdResults, table', { timeout: 15_000 });
    }

    const notFound: string[] = [];
    for (const [key, originalUserName] of requestedByKey.entries()) {
      if (!matchedKeys.has(key)) notFound.push(originalUserName);
    }

    return { notFound };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // ignore
      }
    }
  }
}
