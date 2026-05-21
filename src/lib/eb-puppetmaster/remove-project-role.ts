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
};

/**
 * Remove one or more users from a project role.
 * Groups by project/role so all users can be selected before triggering a single remove action.
 */
export async function removeUserFromProjectRoleByName(
  options: RemoveUserFromProjectRoleArgs,
): Promise<{ notFound: string[] }> {
  const { env, cookies, browser, projectName, roleName, userNames, dryRun } = options;
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

    // 2. Navigate to the project participants (role management) page
    const roleMgmtUrl = `https://${env}.${baseurl}/da2/Projects/ProjectParticipants.aspx?PortalID={${portalId}}`;
    await page.goto(roleMgmtUrl, { waitUntil: 'networkidle0' });

    // 3. Select the role in the left pane iframe
    const roleListFrameEl = await page.waitForSelector(
      'iframe#RAD_SPLITTER_PANE_EXT_CONTENT_ctl00_ctl00_ContentPlaceHolder1_contentSection_groupList',
    );
    if (!roleListFrameEl) throw new Error('Role list iframe not found');
    const roleFrame = await roleListFrameEl.contentFrame();
    if (!roleFrame) throw new Error('Could not access role list iframe content');

    // Find the role link by trimmed text in the dgAccountRoles table
    const roleLinks = await roleFrame.$$('#dgAccountRoles a[name="selectedGroup"]');
    let roleLink: puppeteer.ElementHandle | null = null;
    for (const link of roleLinks) {
      const text = await link.evaluate((el) => el.textContent?.trim() ?? '');
      if (text === roleName) {
        roleLink = link;
        break;
      }
    }
    if (!roleLink) throw new Error(`Role '${roleName}' not found in project '${projectName}'`);
    await roleLink.click();

    // Wait for the right pane iframe to reload with users for the selected role
    await page.waitForNetworkIdle();

    // 4. Get the user list iframe
    const userListFrameEl = await page.waitForSelector(
      'iframe#RAD_SPLITTER_PANE_EXT_CONTENT_ctl00_ctl00_ContentPlaceHolder1_contentSection_userList',
    );
    if (!userListFrameEl) throw new Error('User list iframe not found');
    const userFrame = await userListFrameEl.contentFrame();
    if (!userFrame) throw new Error('Could not access user list iframe content');

    await userFrame.waitForSelector('#grdResults');

    // 5. Select checkboxes for matching users from the current (non-paginated) grid.
    // Normalize usernames to avoid case/whitespace mismatches.
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

    // 6. Click remove once for all selected users (if not dry-run) and accept confirmation.
    if (!dryRun && matchedKeys.size > 0) {
      const removeBtn = await userFrame.waitForSelector('#btnRoleRemove');
      if (!removeBtn) throw new Error('Remove button not found');
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
