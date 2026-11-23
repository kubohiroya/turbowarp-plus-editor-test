// The test run view running tests in a frame of their own, as the editor runs them: results, the context the editor
// sends, stopping, and a run the frame refuses.
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser, type Page} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';

let server: Awaited<ReturnType<typeof serveEditorRuntime>>;
let browser: Browser;
before(async () => {
    server = await serveEditorRuntime({script: fileURLToPath(new URL('./browser/frame.page.ts', import.meta.url))});
    browser = await chromium.launch(process.env.TWPE_CHROME_EXECUTABLE ? {executablePath: process.env.TWPE_CHROME_EXECUTABLE} : {});
});
after(async () => {
    await browser?.close();
    await server?.close();
});

const open = async (options: {locale?: string; frameLimit?: number; refuse?: boolean} = {}) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url);
    await page.evaluate(value => (globalThis as any).setup(value), {locale: 'en', frameLimit: 30, ...options});
    return {page, errors};
};
const statuses = (page: Page) => page.locator('#view .twpe-test-run__test').evaluateAll(items =>
    items.map(item => [(item as HTMLElement).dataset.address, (item as HTMLElement).dataset.status]));
const summary = (page: Page) => page.locator('#view .twpe-test-run__summary');

test('runs the tests in the frame and shows their results', async () => {
    const {page, errors} = await open();
    assert.equal(await page.evaluate(() => (globalThis as any).harness.frames()), 0, 'no frame before a run');
    await page.getByRole('button', {name: 'Run all', exact: true}).click();
    await summary(page).filter({hasText: '5 tests'}).waitFor();
    assert.deepEqual(await statuses(page), [
        ['Cat/first', 'passed'], ['Cat/second', 'passed'], ['Cat/failing', 'failed'],
        ['Cat/forever', 'timed-out'], ['Twice/twiceTest', 'error']
    ]);
    assert.equal(await page.locator('#view [data-address="Cat/failing"] .twpe-test-run__check').textContent(),
        'Not trueExpected: trueActual: false');
    assert.equal(await page.evaluate(() => (globalThis as any).harness.frames()), 1);
    assert.equal(await page.locator('#view .twpe-test-run__stage iframe').count(), 1, 'the frame is the stage');
    assert.deepEqual(await page.evaluate(() => (globalThis as any).harness.contexts()),
        [{digests: ['0'.repeat(64)], refuse: false}], 'the frame got what the editor sent');
    // A second run reuses the frame.
    await page.getByRole('button', {name: 'Run: fails'}).click();
    await page.getByRole('button', {name: 'Run all', exact: true}).and(page.locator(':enabled')).waitFor();
    assert.equal(await page.evaluate(() => (globalThis as any).harness.frames()), 1);
    assert.equal(await page.evaluate(() => (globalThis as any).harness.contexts().length), 2);
    assert.deepEqual(errors, []);
    await page.close();
});

test('stops a run in the frame', async () => {
    const {page, errors} = await open({frameLimit: 1_000_000});
    await page.getByRole('button', {name: 'Run: never ends'}).click();
    await page.locator('#view [data-address="Cat/forever"][data-status="running"]').waitFor();
    await page.getByRole('button', {name: 'Stop'}).click();
    await summary(page).filter({hasText: 'Stopped.'}).waitFor();
    assert.equal((await statuses(page))[3]![1], 'pending');
    // The frame is free again for the next run.
    await page.getByRole('button', {name: 'Run: first visit'}).click();
    await page.locator('#view [data-address="Cat/first"][data-status="passed"]').waitFor();
    assert.deepEqual(errors, []);
    await page.close();
});

test('shows why the frame refused a run', async () => {
    const {page, errors} = await open({refuse: true});
    await page.getByRole('button', {name: 'Run all', exact: true}).click();
    await summary(page).filter({hasText: 'This code is not trusted.'}).waitFor();
    assert.ok((await statuses(page)).every(([, status]) => status === 'pending'));
    assert.deepEqual(errors, []);
    await page.close();
});
