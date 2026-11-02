import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as http from 'http';
import type { AddressInfo } from 'net';
import puppeteer from 'puppeteer';
import { executeInSession, Environment } from '../../lib/eb-puppetmaster/index.js';

const FORM_PAGE = `<!DOCTYPE html><html><head><title>WebForm</title></head><body>
<form id="aspnetForm" method="post" action="/echo">
  <input type="hidden" name="__VIEWSTATE" value="vs123" />
  <input type="hidden" name="__EVENTVALIDATION" value="ev456" />
  <input type="text" name="ctl00$Main$txtName" value="Alice" />
  <input type="checkbox" name="ctl00$Main$chkActive" />
  <select name="ctl00$Main$ddlStatus"><option value="1">Open</option><option value="2" selected>Closed</option></select>
  <input type="submit" name="ctl00$Main$btnSave" value="Save" />
</form></body></html>`;

const REPORT_PAGE = `<!DOCTYPE html><html><body>
<form id="aspnetForm" method="post">
  <input type="hidden" name="__VIEWSTATE" value="rv" />
  <input type="radio" name="ctl00$cph$rblExportTypes" value="1" checked />
  <input type="radio" name="ctl00$cph$rblExportTypes" value="5" />
  <input type="submit" name="ctl00$cph$btnExportType" value="Export" />
</form></body></html>`;

describe('In-browser eb WebForms / workflow / report helpers', () => {
  let browser: puppeteer.Browser;
  let server: http.Server;
  let origin: string;

  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (url.pathname === '/form') {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(FORM_PAGE);
        } else if (url.pathname === '/echo') {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<p id="body">${body}</p>`);
        } else if (url.pathname.endsWith('/Workflows/DownloadWorkflowHandler.ashx')) {
          res
            .writeHead(200, { 'Content-Type': 'application/octet-stream' })
            .end(`<?xml version="1.0"?><Workflow id="${url.searchParams.get('WorkflowID')}"/>`);
        } else if (url.pathname === '/da2/Reports/ReportResults.aspx') {
          if (req.method === 'POST') {
            const p = new URLSearchParams(body);
            const ok =
              p.get('ctl00$cph$rblExportTypes') === '5' &&
              p.get('ctl00$cph$btnExportType') === 'Export' &&
              p.get('__VIEWSTATE') === 'rv';
            res
              .writeHead(200, { 'Content-Type': ok ? 'text/csv' : 'text/html' })
              .end(ok ? 'A,B\n1,2\n' : '<html>bad export</html>');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' }).end(REPORT_PAGE);
          }
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  });

  after(async () => {
    await browser?.close();
    await new Promise((r) => server.close(r));
  });

  const run = (script: string, mode: 'dom' | 'puppeteer' = 'dom', path = '/form') =>
    executeInSession({
      env: Environment.US1,
      cookies: [],
      browser,
      url: `${origin}${path}`,
      script,
      mode,
      screenshotOnFailure: false,
    });

  it('buildFormParams serializes the form like a browser, with short-name overrides', async () => {
    const { result } = await run(
      `(arg, eb) => eb.buildFormParams(null, { txtName: 'Bob', __VIEWSTATE: null }, 'ctl00$Main$lnkGo').toString()`,
    );
    const p = new URLSearchParams(result as string);
    assert.strictEqual(p.get('ctl00$Main$txtName'), 'Bob');
    assert.strictEqual(p.get('__VIEWSTATE'), null);
    assert.strictEqual(p.get('__EVENTVALIDATION'), 'ev456');
    assert.strictEqual(p.get('ctl00$Main$ddlStatus'), '2');
    assert.strictEqual(p.get('ctl00$Main$chkActive'), null);
    assert.strictEqual(p.get('ctl00$Main$btnSave'), null);
    assert.strictEqual(p.get('__EVENTTARGET'), 'ctl00$Main$lnkGo');
  });

  it('postWebForm posts to the form action and returns parsed HTML', async () => {
    const { result } = await run(
      `async (arg, eb) => {
        const r = await eb.postWebForm(null, '#aspnetForm', { btnSave: 'Save' });
        return { status: r.status, body: r.doc.getElementById('body').textContent };
      }`,
    );
    const r = result as { status: number; body: string };
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /ctl00%24Main%24btnSave=Save/);
    assert.match(r.body, /__VIEWSTATE=vs123/);
  });

  it('exposes helpers to Puppeteer scripts via ctx.eb with serializable results', async () => {
    const { result } = await run(
      `async ({ eb }) => ({
        params: await eb.buildFormParams('#aspnetForm'),
        posted: await eb.postWebForm(null, null),
      })`,
      'puppeteer',
    );
    const r = result as { params: string; posted: { status: number; html: string; doc?: unknown } };
    assert.match(r.params, /__VIEWSTATE=vs123/);
    assert.strictEqual(r.posted.status, 200);
    assert.ok(r.posted.html.includes('id="body"'));
    assert.strictEqual(r.posted.doc, undefined);
  });

  it('downloadWorkflowXml fetches the workflow handler', async () => {
    const { result } = await run(`(arg, eb) => eb.downloadWorkflowXml('wf-guid-1')`);
    assert.match(result as string, /<Workflow id="wf-guid-1"\/>/);
  });

  it('exportReportCsv posts the CSV export postback', async () => {
    const { result } = await run(`(arg, eb) => eb.exportReportCsv('rep-1')`);
    assert.strictEqual(result, 'A,B\n1,2\n');
  });
});
