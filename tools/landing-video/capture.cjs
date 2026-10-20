// Visible, real Electron capture. No provider mocks or report fixtures.
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const data = process.env.LISTENER_DEMO_DATA;
if (!data || !path.isAbsolute(data))
  throw new Error('Set LISTENER_DEMO_DATA to an absolute isolated demo directory');
(async () => {
  const app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LISTENER_DATA_PATH: data,
      LISTENER_BACKGROUND_TEST: '0',
    },
    recordVideo: { dir: data + '/raw-video', size: { width: 1280, height: 900 } },
  });
  await app.firstWindow();
  await new Promise((r) => setTimeout(r, 1800));
  console.log(
    'WINDOWS',
    (await app.windows()).map((p) => p.url()),
  );
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.closeDevTools();
  });
  const page = (await app.windows()).find((p) => p.url().startsWith('file:'));
  if (!page) throw Error('No source renderer window');
  page.setDefaultTimeout(30000);
  console.log('RENDERER', page.url());
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1280, 900);
    w.center();
  });
  const shot = async (n) => {
    await page.screenshot({ path: `${data}/${n}.png` });
    console.log('FRAME', n, Date.now());
  };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await pause(1800);
    await shot('01-home');
    page.on('dialog', async (d) => {
      console.log('DIALOG', d.type(), d.message());
      await d.accept();
    });
    // Native picker automation selects the actual source file, without replacing any IPC/provider response.
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, data + '/Product-design-meeting.wav');
    if (!fs.existsSync(data + '/transcriptions')) await page.locator('#dragDropZone').click();
    await pause(3000);
    await shot('02-processing');
    console.log('PROCESSING_STARTED');
    await page
      .locator('.recording-item[data-has-transcript="true"]')
      .first()
      .waitFor({ state: 'visible', timeout: 300000 });
    await shot('03-saved');
    await pause(1800);
    await page.locator('.recording-item[data-has-transcript="true"]').first().click();
    await page.locator('#transcriptionModal').waitFor({ state: 'visible' });
    await pause(2000);
    await shot('04-report');
    await page.locator('[data-tab="summary"]').click();
    await pause(2500);
    await shot('05-summary');
    await page.locator('[data-tab="transcript"]').click();
    await pause(2500);
    await shot('06-transcript');
    await page.locator('[data-tab="ask"]').click();
    await page
      .locator('#modalChatInput')
      .fill('What is the team designing, and what requirements were discussed?');
    await pause(1000);
    await page.locator('#modalChatSend').click();
    await page.locator('#modalChatSend').waitFor({ state: 'visible' });
    await page.waitForFunction(
      () => !document.querySelector('#modalChatSend').disabled,
      {},
      { timeout: 90000 },
    );
    await pause(5000);
    await shot('07-ask');
    fs.writeFileSync(data + '/visible-ui.txt', await page.locator('body').innerText());
    console.log('VIDEO', await page.video().path());
  } catch (e) {
    console.error('CAPTURE_FAILED', e.message);
    await shot('failure');
    fs.writeFileSync(data + '/failure-ui.txt', await page.locator('body').innerText());
    process.exitCode = 1;
  } finally {
    await app.close();
  }
})();
