import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { chromium, type Browser, type Page } from 'playwright';
import {
  getPortalIdByProjectName,
  clearProjectCache,
  Environment,
  BrowserManager,
} from '../../lib/eb-puppetmaster/index.js';

describe('Project Scraping & Cache (src/lib/eb-puppetmaster/project.ts)', () => {
  let browser: Browser;
  let page: Page;

  before(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  });

  after(async () => {
    if (browser) {
      await browser.close();
    }
    await BrowserManager.getInstance().closeBrowser();
  });

  beforeEach(async () => {
    clearProjectCache();
    page = await browser.newPage();
  });

  afterEach(async () => {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
  });

  it('resolves project PortalID from project table rows', async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <table class="grid">
            <tr class="RowData">
              <td>1</td>
              <td>Active</td>
              <td><a href="/da2/Projects/ProjectDetails.aspx?PortalID={AAAA-1111}">Hospital Renovation</a></td>
            </tr>
            <tr class="AltRowData">
              <td>2</td>
              <td>Active</td>
              <td><a href="/da2/Projects/ProjectDetails.aspx?PortalID=BBBB-2222">Airport Terminal B</a></td>
            </tr>
          </table>
        </body>
      </html>
    `;

    await page.setContent(mockHtml);
    page.goto = async () => null as any;

    const portalId1 = await getPortalIdByProjectName(page, Environment.US1, 'Hospital Renovation');
    assert.strictEqual(portalId1, 'AAAA-1111');

    const portalId2 = await getPortalIdByProjectName(page, Environment.US1, 'Airport Terminal B');
    assert.strictEqual(portalId2, 'BBBB-2222');
  });

  it('uses cache on subsequent lookups without querying DOM again', async () => {
    const mockHtml = `
      <html>
        <body>
          <table>
            <tr class="RowData">
              <td>1</td><td>Active</td>
              <td><a href="?PortalID=CACHED-999">Cached Project</a></td>
            </tr>
          </table>
        </body>
      </html>
    `;
    await page.setContent(mockHtml);
    page.goto = async () => null as any;

    const id1 = await getPortalIdByProjectName(page, Environment.US1, 'Cached Project');
    assert.strictEqual(id1, 'CACHED-999');

    await page.setContent('<html><body>Empty</body></html>');

    const id2 = await getPortalIdByProjectName(page, Environment.US1, 'cached project');
    assert.strictEqual(id2, 'CACHED-999');
  });

  it('throws error when project is not found on page', async () => {
    await page.setContent('<html><body><table></table></body></html>');
    page.goto = async () => null as any;

    await assert.rejects(
      async () => getPortalIdByProjectName(page, Environment.US1, 'Nonexistent Project'),
      /Project 'Nonexistent Project' not found in project list/,
    );
  });
});
