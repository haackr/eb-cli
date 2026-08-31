import { type Browser, type Page, type Frame, type ElementHandle } from 'playwright';
import { Environment, baseurl, BrowserManager, normalizeCookies, type Cookie } from './index.js';
import { getPortalIdByProjectName } from './project.js';

export type RemoveUserFromProjectRoleArgs = {
  env: Environment;
  cookies: Cookie[];
  browser?: Browser;
  projectName: string;
  roleName: string;
  userNames: string[];
  dryRun: boolean;
};

export async function findRemoveButton(userFrame: Frame | Page): Promise<ElementHandle | null> {
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
  userFrame: Frame | Page,
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

    const remaining = new Set(keys.map((k) => k.toLowerCase().trim()).filter(Boolean));
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
          if (text) rowIdentifiers.add(text);
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
      for (const req of remaining) {
        const reqInverted = normalizeName(req);
        const reqPrefix = req.includes('@') ? (req.split('@')[0]?.trim() ?? '') : '';

        if (
          rowIdentifiers.has(req) ||
          (reqInverted && rowIdentifiers.has(reqInverted)) ||
          (reqPrefix && rowIdentifiers.has(reqPrefix))
        ) {
          matchedKey = req;
          break;
        }
      }

      if (matchedKey) {
        if (!checkbox.checked) {
          checkbox.click();
        }
        if (checkbox.checked) {
          matched.push(matchedKey);
          remaining.delete(matchedKey);
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
): Promise<{ notFound: string[] }> {
  const { env, cookies, browser, projectName, roleName, userNames, dryRun } = options;
  const browserInstance = browser || (await BrowserManager.getInstance().getBrowser());

  let page: Page | null = null;
  try {
    if (!browserInstance.isConnected()) {
      throw new Error('Browser is not connected');
    }
    const context =
      (await BrowserManager.getInstance().getDefaultContext(browserInstance)) ||
      (await browserInstance.newContext());
    await context.addCookies(normalizeCookies(cookies));
    page = await context.newPage();

    // Auto-accept any confirmation dialogs (e.g. "Are you sure you want to remove...")
    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {}
    });

    // 1. Find the project's PortalID from the project list
    const portalId = await getPortalIdByProjectName(page, env, projectName);

    // 2. Navigate to the project participants (role management) page
    const roleMgmtUrl = `https://${env}.${baseurl}/da2/Projects/ProjectParticipants.aspx?PortalID={${portalId}}`;
    await page.goto(roleMgmtUrl, { waitUntil: 'domcontentloaded' });

    // 3. Select the role in the left pane iframe
    const roleListFrameEl = await page.waitForSelector(
      'iframe#RAD_SPLITTER_PANE_EXT_CONTENT_ctl00_ctl00_ContentPlaceHolder1_contentSection_groupList, iframe[name*="groupList"]',
      { timeout: 30_000 },
    );
    if (!roleListFrameEl) throw new Error('Role list iframe not found');
    const roleFrame = await roleListFrameEl.contentFrame();
    if (!roleFrame) throw new Error('Could not access role list iframe content');

    await roleFrame.waitForSelector('#dgAccountRoles, table', { timeout: 30_000 });

    // Find the role link by trimmed text in the dgAccountRoles table
    const targetRoleNameNorm = roleName.trim().toLowerCase();
    const roleLinks = await roleFrame.$$(
      '#dgAccountRoles a[name="selectedGroup"], #dgAccountRoles a, table a',
    );
    let roleLink: ElementHandle | null = null;
    for (const link of roleLinks) {
      const text = await link.evaluate((el) => el.textContent?.trim() ?? '');
      if (text.toLowerCase() === targetRoleNameNorm) {
        roleLink = link;
        break;
      }
    }
    if (!roleLink) throw new Error(`Role '${roleName}' not found in project '${projectName}'`);

    // Click role link and wait for the right pane iframe to reload with users
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null),
      roleLink.click(),
    ]);

    // 4. Helper to get the user list iframe
    async function getUserFrame(): Promise<Frame> {
      const userListFrameEl = await page!.waitForSelector(
        'iframe#RAD_SPLITTER_PANE_EXT_CONTENT_ctl00_ctl00_ContentPlaceHolder1_contentSection_userList, iframe[name*="userList"]',
        { timeout: 30_000 },
      );
      if (!userListFrameEl) throw new Error('User list iframe not found');
      const userFrame = await userListFrameEl.contentFrame();
      if (!userFrame) throw new Error('Could not access user list iframe content');
      return userFrame;
    }

    let userFrame = await getUserFrame();
    await userFrame.waitForSelector('#grdResults, table', { timeout: 30_000 });

    // 5. Match and select users across all grid pages
    const requestedByKey = new Map<string, string>();
    for (const userName of userNames) {
      const key = userName.trim().toLowerCase();
      if (key && !requestedByKey.has(key)) {
        requestedByKey.set(key, userName);
      }
    }

    const matchedKeys = new Set<string>();
    const remainingKeys = () =>
      Array.from(requestedByKey.keys()).filter((k) => !matchedKeys.has(k));

    while (true) {
      userFrame = await getUserFrame();
      const currentMatched = await selectMatchingUsersOnCurrentPage(userFrame, remainingKeys());
      if (currentMatched.length > 0) {
        for (const k of currentMatched) {
          matchedKeys.add(k);
        }

        if (!dryRun) {
          const removeBtn = await findRemoveButton(userFrame);
          if (!removeBtn) {
            throw new Error('Remove button not found in user list iframe');
          }

          await Promise.all([
            page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null),
            removeBtn.click(),
          ]);

          userFrame = await getUserFrame();
          await userFrame
            .waitForSelector('#grdResults, table', { timeout: 20_000 })
            .catch(() => null);

          if (remainingKeys().length > 0) {
            continue;
          }
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

      const nextLinkEl = nextGridLink.asElement() as ElementHandle<HTMLElement> | null;
      if (!nextLinkEl) break;

      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null),
        nextLinkEl.click(),
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
      } catch {}
    }
  }
}
