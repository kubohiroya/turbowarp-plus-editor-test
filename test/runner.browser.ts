// The runner on the Editor's pinned VM: each test starts from a fresh copy, "before each test" runs first, and
// failures, timeouts and unrunnable tests are told apart.
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';

let server: Awaited<ReturnType<typeof serveEditorRuntime>>;
let browser: Browser;
before(async () => {
    server = await serveEditorRuntime({script: fileURLToPath(new URL('./browser/runner.page.ts', import.meta.url))});
    browser = await chromium.launch(process.env.TWPE_CHROME_EXECUTABLE ? {executablePath: process.env.TWPE_CHROME_EXECUTABLE} : {});
});
after(async () => {
    await browser?.close();
    await server?.close();
});

const run = async (options: {only?: string[]; frameLimit?: number}) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url);
    const outcome = await page.evaluate(value => (globalThis as any).run(value), options);
    await page.close();
    return {...outcome, errors};
};

test('runs every test from a fresh copy, after its target\'s "before each test"', async () => {
    const {report, started, errors} = await run({frameLimit: 20});
    assert.deepEqual(started, ['Cat/first', 'Cat/second', 'Cat/failing', 'Cat/forever', 'Twice/twiceTest']);
    assert.deepEqual(report.results.map((result: any) => [result.address, result.name, result.status]), [
        ['Cat/first', 'first visit', 'passed'],
        // Passes only if the first test's visit was undone and "before each test" ran again.
        ['Cat/second', 'second visit', 'passed'],
        ['Cat/failing', 'fails', 'failed'],
        ['Cat/forever', 'never ends', 'timed-out'],
        ['Twice/twiceTest', 'cannot run', 'error']
    ]);
    assert.deepEqual(report.counts, {passed: 2, failed: 1, 'timed-out': 1, error: 1});
    assert.equal(report.ok, false);
    assert.deepEqual(report.results[0].assertions.map((record: any) => [record.blockId, record.passed]),
        [['firstCount', true], ['firstCheck', true]]);
    assert.deepEqual(report.results[2].assertions.map((record: any) => [record.blockId, record.topBlockId, record.passed]),
        [['failingCheck', 'failing', false]]);
    assert.equal(report.results[3].frames, 20);
    assert.match(report.results[4].message, /more than one "before each test"/);
    assert.deepEqual(errors, []);
});

test('runs only the chosen tests, and the green flag script never runs', async () => {
    const {report, visits, junit, errors} = await run({only: ['Cat/failing']});
    assert.deepEqual(report.results.map((result: any) => result.status), ['failed']);
    // The failed check stopped the script before it set visits to 5, and nothing pressed the green flag (999).
    assert.equal(visits, 0);
    assert.match(junit, /<testsuite name="Cat" tests="1" failures="1" errors="0"/);
    assert.match(junit, /<failure message="true at block failingCheck, expected true, actual false">/);
    assert.deepEqual(errors, []);
});

test('refuses an address that names no test', async () => {
    const page = await browser.newPage();
    await page.goto(server.url);
    await assert.rejects(page.evaluate(() => (globalThis as any).run({only: ['Cat/nothing']})), /No test at Cat\/nothing/);
    await page.close();
});
