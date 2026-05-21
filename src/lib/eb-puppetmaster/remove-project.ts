import puppeteer from 'puppeteer';
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
    await page.goto(projectParticipantsUrl, { waitUntil: 'networkidle0' });

    // 3. Get the user list iframe
    const userListFrameEl = await page.waitForSelector(
      'iframe#RAD_SPLITTER_PANE_EXT_CONTENT_ctl00_ctl00_ContentPlaceHolder1_contentSection_userList',
    );
    if (!userListFrameEl) throw new Error('User list iframe not found');
    const userFrame = await userListFrameEl.contentFrame();
    if (!userFrame) throw new Error('Could not access user list iframe content');

    await userFrame.waitForSelector('#grdResults');

    // 4. Select checkboxes for matching users from the current (non-paginated) grid.
    const requestedByKey = new Map<string, string>();
    for (const userName of userNames) {
      const key = userName.trim().toLowerCase();
      if (!requestedByKey.has(key)) requestedByKey.set(key, userName);
    }

    const matchedKeys = new Set(
      await userFrame.evaluate((keys: string[]) => {
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
      }, Array.from(requestedByKey.keys())),
    );

    // 5. Click remove once for all selected users (if not dry-run) and accept confirmation.
    if (!dryRun && matchedKeys.size > 0) {
      const removeBtn = await userFrame.waitForSelector('#btnRemove');
      if (!removeBtn) throw new Error('Remove from Project button not found');
      page.once('dialog', (dialog) => dialog.accept());
      await removeBtn.click();
      await page.waitForNetworkIdle();
      await userFrame.waitForSelector('#grdResults');
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
