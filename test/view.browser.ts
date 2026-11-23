// The test run view on the Editor's pinned VM: listing, running all or one, stopping, and finding a failed check.
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser, type Page} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';

let server: Awaited<ReturnType<typeof serveEditorRuntime>>;
let browser: Browser;
before(async () => {
    server = await serveEditorRuntime({script: fileURLToPath(new URL('./browser/view.page.ts', import.meta.url))});
    browser = await chromium.launch(process.env.TWPE_CHROME_EXECUTABLE ? {executablePath: process.env.TWPE_CHROME_EXECUTABLE} : {});
});
after(async () => {
    await browser?.close();
    await server?.close();
});

const open = async (locale = 'en', frameLimit = 30, more: {archive?: boolean; list?: boolean} = {}) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url);
    await page.evaluate(options => (globalThis as any).setup(options), {locale, frameLimit, ...more});
    return {page, errors};
};
const rows = (page: Page) => page.locator('#view .twpe-test-run__test').evaluateAll(items => items.map(item => [
    (item as HTMLElement).dataset.address, (item as HTMLElement).dataset.status,
    item.querySelector('.twpe-test-run__name')!.textContent
]));
const summary = (page: Page) => page.locator('#view .twpe-test-run__summary');

test('lists the tests before they run, without creating the test VM', async () => {
    const {page, errors} = await open();
    assert.deepEqual(await rows(page), [
        ['Cat/first', 'pending', 'first visit'],
        ['Cat/second', 'pending', 'second visit'],
        ['Cat/failing', 'pending', 'fails'],
        ['Cat/forever', 'pending', 'never ends'],
        ['Twice/twiceTest', 'pending', 'cannot run']
    ]);
    assert.equal(await page.evaluate(() => (globalThis as any).harness.vmCreated()), 0);
    assert.deepEqual(errors, []);
    await page.close();
});

test('runs all tests, shows each result, and finds the block of a failed check', async () => {
    const {page, errors} = await open();
    await page.getByRole('button', {name: 'Run all', exact: true}).click();
    await summary(page).filter({hasText: '5 tests'}).waitFor();
    assert.equal(await summary(page).textContent(), '5 tests: 2 passed, 1 failed, 1 timed out, 1 errors');
    assert.deepEqual((await rows(page)).map(([address, status]) => [address, status]), [
        ['Cat/first', 'passed'], ['Cat/second', 'passed'], ['Cat/failing', 'failed'],
        ['Cat/forever', 'timed-out'], ['Twice/twiceTest', 'error']
    ]);
    const failing = page.locator('#view [data-address="Cat/failing"]');
    assert.equal(await failing.locator('.twpe-test-run__check').textContent(), 'Not trueExpected: trueActual: falseShow block');
    await failing.getByRole('button', {name: 'Show block'}).click();
    assert.deepEqual(await page.evaluate(() => (globalThis as any).harness.shown), [['Cat', 'failingCheck']]);
    assert.match(await page.locator('#view [data-address="Twice/twiceTest"] .twpe-test-run__message').textContent() ?? '',
        /more than one "before each test" hat, so its tests cannot run\./);
    assert.equal(await page.evaluate(() => (globalThis as any).harness.vmCreated()), 1);
    assert.deepEqual(errors, []);
    await page.close();
});

test('runs one test and keeps the others\' results', async () => {
    const {page, errors} = await open();
    await page.getByRole('button', {name: 'Run all', exact: true}).click();
    await summary(page).filter({hasText: '5 tests'}).waitFor();
    await page.getByRole('button', {name: 'Run: second visit'}).click();
    await page.getByRole('button', {name: 'Run all', exact: true}).and(page.locator(':enabled')).waitFor();
    assert.deepEqual((await rows(page)).map(([, status]) => status), ['passed', 'passed', 'failed', 'timed-out', 'error']);
    assert.deepEqual(errors, []);
    await page.close();
});

test('stops a run', async () => {
    const {page, errors} = await open('en', 1_000_000);
    await page.getByRole('button', {name: 'Run: never ends'}).click();
    await page.locator('#view [data-address="Cat/forever"][data-status="running"]').waitFor();
    await page.getByRole('button', {name: 'Stop'}).click();
    await summary(page).filter({hasText: 'Stopped.'}).waitFor();
    assert.equal((await rows(page))[3][1], 'pending');
    assert.equal(await page.getByRole('button', {name: 'Run all', exact: true}).isEnabled(), true);
    assert.deepEqual(errors, []);
    await page.close();
});

test('speaks Japanese, and offers its menu item and workspace tab', async () => {
    const {page, errors} = await open('ja');
    assert.equal(await page.locator('#view .twpe-test-run').getAttribute('lang'), 'ja');
    await page.getByRole('button', {name: 'すべて実行'}).click();
    await summary(page).filter({hasText: '5件中'}).waitFor();
    assert.equal(await summary(page).textContent(), '5件中 成功 2・失敗 1・時間切れ 1・エラー 1');
    assert.equal(await page.locator('#view [data-address="Cat/forever"] .twpe-test-run__message').textContent(),
        'テストが 30 フレームで終わりませんでした。');
    assert.deepEqual(await page.evaluate(() => (globalThis as any).harness.menuItem()),
        {id: 'open-test-run-view', label: 'テスト実行画面を開く', opened: 1});
    assert.deepEqual(await page.evaluate(() => (globalThis as any).harness.panel()), {
        reference: {providerId: 'turbowarp-plus', documentId: 'tests'}, title: 'テスト実行画面', transient: true,
        mounted: 1, closed: 1, left: 0
    });
    assert.deepEqual(errors, []);
    await page.close();
});

test('lists the tests from listProject when the project to run is an archive', async () => {
    const {page, errors} = await open('en', 30, {archive: true, list: true});
    assert.deepEqual((await rows(page)).map(([address, status]) => [address, status]), [
        ['Cat/first', 'pending'], ['Cat/second', 'pending'], ['Cat/failing', 'pending'],
        ['Cat/forever', 'pending'], ['Twice/twiceTest', 'pending']
    ]);
    assert.equal(await summary(page).textContent(), '');
    assert.deepEqual(errors, []);
    await page.close();
});

test('says the tests are listed once they run when it cannot read the project', async () => {
    const {page, errors} = await open('en', 30, {archive: true});
    assert.deepEqual(await rows(page), []);
    assert.equal(await summary(page).textContent(), 'The tests are listed once they run.');
    assert.deepEqual(errors, []);
    await page.close();
});
