// SPDX-License-Identifier: MPL-2.0
/**
 * The test run view: a stage of its own, the project's tests, and their results. It runs the tests on a VM the
 * host creates for it, never on the editor's, and shows each failed check with a way to find its block. It is plain
 * DOM so that it can live in a workspace tab, a window or a test page alike.
 */
import type {AssertionRecord} from './protocol.ts';
import {discoverTests, type DiscoveredTest} from './test-discovery.ts';
import {DEFAULT_FRAME_LIMIT, type RunnerVM, type TestResult, type TestStatus} from './test-runner.ts';
import {vmRunner, type Project, type TestRunnerPort} from './test-frame.ts';

export interface TestRunViewOptions {
    document: Document;
    locale: string;
    /**
     * A copy of the editor's project, taken when a run starts. Pass `project.json` as text or an object to list the
     * tests before they run: `editorVm.toJSON(undefined, {allowOptimization: false})` keeps the editor's block IDs.
     */
    getProject(): Project | Promise<Project>;
    /**
     * The project's `project.json`, as text or an object, to list the tests from when `getProject` returns an SB3
     * archive, which the view cannot read. Read when the view opens or refreshes and when a run starts. It must carry
     * the same block IDs as the project the tests run on.
     */
    listProject?(): string | object | Promise<string | object>;
    /**
     * What runs the tests, created on the first run with the element the stage goes in. In the editor this is a
     * frame running `serveTestFrame` (`connectTestFrame`): only one VM of a page can load extensions.
     */
    createRunner?(stage: HTMLElement): TestRunnerPort | Promise<TestRunnerPort>;
    /**
     * Or a VM of this page to run tests on, created on the first run, which draws its stage into `stage` and has the
     * extensions the project needs, including TurboWarp-Test. It must not be the editor's VM.
     */
    createVm?(stage: HTMLElement): RunnerVM | Promise<RunnerVM>;
    /** Shows a block of the editor's project, such as a check that failed. Without it no link is offered. */
    showBlock?(target: string, blockId: string): void;
    frameLimit?: number;
}

export interface TestRunView {
    element: HTMLElement;
    /** Lists the tests of the project as it is now. */
    refresh(): Promise<void>;
    runAll(): Promise<void>;
    run(address: string): Promise<void>;
    stop(): void;
    dispose(): void;
}

const texts = {
    ja: {
        title: 'テスト実行画面',
        open: 'テスト実行画面を開く',
        runAll: 'すべて実行',
        run: '実行',
        stop: '止める',
        stage: 'テストの実行画面',
        tests: 'テスト',
        noTests: 'この作品にはテストがありません。拡張機能「テスト」のテストハットでテストを書きます。',
        unnamed: '（名前なし）',
        running: '実行中…',
        stopped: '止めました。',
        cannotList: 'テストの一覧は、実行すると表示されます。',
        showBlock: 'ブロックを表示',
        status: {passed: '成功', failed: '失敗', 'timed-out': '時間切れ', error: 'エラー', pending: '未実行', running: '実行中'},
        summary: (counts: Record<TestStatus, number>, total: number) =>
            `${total}件中 成功 ${counts.passed}・失敗 ${counts.failed}・時間切れ ${counts['timed-out']}・エラー ${counts.error}`,
        frames: (frames: number) => `${frames}フレーム`,
        reason: {
            'duplicate-setups': (test: DiscoveredTest) => `${test.target} に「テストの前に」ハットが2つ以上あるため、実行できません。`,
            'missing-target': (test: DiscoveredTest) => `${test.target} というスプライトもステージもありません。`,
            'setup-timed-out': (_: DiscoveredTest, limit: number) => `「テストの前に」が ${limit} フレームで終わりませんでした。`,
            'timed-out': (_: DiscoveredTest, limit: number) => `テストが ${limit} フレームで終わりませんでした。`,
            exception: (_: DiscoveredTest, __: number, message: string) => `ブロックがエラーを出しました: ${message}`
        },
        expected: '期待',
        actual: '実際',
        tolerance: '誤差',
        kind: {
            'strict-equals': '=== で等しくない',
            equals: 'Scratch の = で等しくない',
            true: '真でない',
            close: '誤差の範囲を超えている',
            'list-equals': 'リストが等しくない',
            eventually: 'フレーム以内に真にならなかった',
            'wait-until': '待機の上限を超えた'
        }
    },
    en: {
        title: 'Test run view',
        open: 'Open the test run view',
        runAll: 'Run all',
        run: 'Run',
        stop: 'Stop',
        stage: 'Test stage',
        tests: 'Tests',
        noTests: 'This project has no tests. Write them under the test hat of the Test extension.',
        unnamed: '(unnamed)',
        running: 'Running…',
        stopped: 'Stopped.',
        cannotList: 'The tests are listed once they run.',
        showBlock: 'Show block',
        status: {passed: 'Passed', failed: 'Failed', 'timed-out': 'Timed out', error: 'Error', pending: 'Not run', running: 'Running'},
        summary: (counts: Record<TestStatus, number>, total: number) =>
            `${total} tests: ${counts.passed} passed, ${counts.failed} failed, ${counts['timed-out']} timed out, ${counts.error} errors`,
        frames: (frames: number) => `${frames} frames`,
        reason: {
            'duplicate-setups': (test: DiscoveredTest) => `${test.target} has more than one "before each test" hat, so its tests cannot run.`,
            'missing-target': (test: DiscoveredTest) => `There is no sprite or stage named ${test.target}.`,
            'setup-timed-out': (_: DiscoveredTest, limit: number) => `"Before each test" did not end within ${limit} frames.`,
            'timed-out': (_: DiscoveredTest, limit: number) => `The test did not end within ${limit} frames.`,
            exception: (_: DiscoveredTest, __: number, message: string) => `A block threw an error: ${message}`
        },
        expected: 'Expected',
        actual: 'Actual',
        tolerance: 'Tolerance',
        kind: {
            'strict-equals': 'Not equal by ===',
            equals: "Not equal by Scratch's =",
            true: 'Not true',
            close: 'Outside the tolerance',
            'list-equals': 'The lists differ',
            eventually: 'Did not become true in time',
            'wait-until': 'The wait ran out of frames'
        }
    }
};

export const testRunText = (locale: string) => /^ja(?:-|$)/i.test(locale) ? texts.ja : texts.en;

/** The workspace tab of the view, for `getDocumentWorkspace(vm).open()` of the workbench. */
export const testRunViewReference = Object.freeze({providerId: 'turbowarp-plus', documentId: 'tests'});

const statusMarks: Record<TestStatus | 'pending' | 'running', string> = {
    passed: '✓', failed: '✗', 'timed-out': '⏱', error: '!', pending: '·', running: '…'
};

const styles = `
.twpe-test-run { display: flex; flex-direction: column; height: 100%; min-height: 0; font: inherit; color: inherit; }
.twpe-test-run__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid rgba(128,128,128,.35); }
.twpe-test-run__bar button, .twpe-test-run__test button, .twpe-test-run__check button { font: inherit; cursor: pointer; }
.twpe-test-run__summary { flex: 1; min-width: 12em; }
.twpe-test-run__body { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px; overflow: auto; min-height: 0; }
.twpe-test-run__stage { flex: 0 0 auto; width: 240px; aspect-ratio: 4 / 3; border: 1px solid rgba(128,128,128,.35); overflow: hidden; }
.twpe-test-run__stage > canvas { width: 100%; height: 100%; display: block; }
.twpe-test-run__list { flex: 1 1 240px; margin: 0; padding: 0; list-style: none; min-width: 0; }
.twpe-test-run__test { padding: 6px 0; border-bottom: 1px solid rgba(128,128,128,.2); }
.twpe-test-run__row { display: flex; align-items: center; gap: 8px; }
.twpe-test-run__mark { width: 1.4em; text-align: center; font-weight: bold; }
.twpe-test-run__test[data-status="passed"] .twpe-test-run__mark { color: #16a34a; }
.twpe-test-run__test[data-status="failed"] .twpe-test-run__mark,
.twpe-test-run__test[data-status="error"] .twpe-test-run__mark { color: #dc2626; }
.twpe-test-run__test[data-status="timed-out"] .twpe-test-run__mark { color: #d97706; }
.twpe-test-run__name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.twpe-test-run__meta { opacity: .7; font-size: .9em; }
.twpe-test-run__checks { margin: 4px 0 0 2.2em; padding: 0; list-style: none; }
.twpe-test-run__check { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; font-size: .92em; }
.twpe-test-run__check code { overflow-wrap: anywhere; }
.twpe-test-run__message { margin: 4px 0 0 2.2em; font-size: .92em; }
.twpe-test-run__empty { margin: 0; padding: 8px 0; opacity: .8; }
`;

function ensureStyles(document: Document) {
    if (document.getElementById('twpe-test-run-styles')) return;
    const style = document.createElement('style');
    style.id = 'twpe-test-run-styles';
    style.textContent = styles;
    document.head.append(style);
}

const show = (value: unknown) => JSON.stringify(value) ?? String(value);

export function createTestRunView(options: TestRunViewOptions): TestRunView {
    const {document} = options;
    const text = testRunText(options.locale);
    ensureStyles(document);
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, content?: string) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (content !== undefined) element.textContent = content;
        return element;
    };
    const root = make('section', 'twpe-test-run');
    root.lang = /^ja(?:-|$)/i.test(options.locale) ? 'ja' : 'en';
    root.setAttribute('aria-label', text.title);
    const bar = make('div', 'twpe-test-run__bar');
    const runAllButton = make('button', undefined, text.runAll);
    runAllButton.type = 'button';
    const stopButton = make('button', undefined, text.stop);
    stopButton.type = 'button';
    stopButton.disabled = true;
    const summary = make('p', 'twpe-test-run__summary');
    summary.setAttribute('role', 'status');
    summary.style.margin = '0';
    bar.append(runAllButton, stopButton, summary);
    const body = make('div', 'twpe-test-run__body');
    const stage = make('div', 'twpe-test-run__stage');
    stage.setAttribute('role', 'img');
    stage.setAttribute('aria-label', text.stage);
    const list = make('ol', 'twpe-test-run__list');
    list.setAttribute('aria-label', text.tests);
    body.append(stage, list);
    root.append(bar, body);

    let tests: DiscoveredTest[] = [];
    // Whether the tests are known: false while the project is an archive the view cannot read, until a run lists them.
    let listed = true;
    const results = new Map<string, TestResult>();
    let runningAddress: string | null = null;
    let controller: AbortController | null = null;
    let runner: Promise<TestRunnerPort> | null = null;
    let disposed = false;

    const checkItem = (test: DiscoveredTest, record: AssertionRecord) => {
        const item = make('li', 'twpe-test-run__check');
        item.append(make('span', undefined, text.kind[record.kind] ?? record.kind));
        if ('expected' in record) item.append(make('span', undefined, `${text.expected}: `), make('code', undefined, show(record.expected)));
        if ('actual' in record) item.append(make('span', undefined, `${text.actual}: `), make('code', undefined, show(record.actual)));
        if (record.tolerance !== undefined) item.append(make('span', undefined, `${text.tolerance}: ${record.tolerance}`));
        if (record.message) item.append(make('span', undefined, record.message));
        if (options.showBlock && record.blockId) {
            const link = make('button', undefined, text.showBlock);
            link.type = 'button';
            link.dataset.blockId = record.blockId;
            link.addEventListener('click', () => options.showBlock!(test.target, record.blockId!));
            item.append(link);
        }
        return item;
    };

    const render = () => {
        list.replaceChildren();
        if (tests.length === 0 && listed) {
            list.append(make('li', 'twpe-test-run__empty', text.noTests));
        }
        for (const test of tests) {
            const result = results.get(test.address);
            const status = runningAddress === test.address ? 'running' : result?.status ?? 'pending';
            const item = make('li', 'twpe-test-run__test');
            item.dataset.address = test.address;
            item.dataset.status = status;
            const row = make('div', 'twpe-test-run__row');
            const mark = make('span', 'twpe-test-run__mark', statusMarks[status]);
            mark.setAttribute('aria-label', text.status[status]);
            mark.title = text.status[status];
            const name = make('span', 'twpe-test-run__name', test.name || text.unnamed);
            name.title = test.address;
            const meta = make('span', 'twpe-test-run__meta', result ? `${test.target} · ${text.frames(result.frames)}` : test.target);
            const run = make('button', undefined, text.run);
            run.type = 'button';
            run.disabled = controller !== null;
            run.setAttribute('aria-label', `${text.run}: ${test.name || text.unnamed}`);
            run.addEventListener('click', () => void view.run(test.address));
            row.append(mark, name, meta, run);
            item.append(row);
            const failed = result?.assertions.filter(record => !record.passed) ?? [];
            if (failed.length) {
                const checks = make('ul', 'twpe-test-run__checks');
                checks.append(...failed.map(record => checkItem(test, record)));
                item.append(checks);
            }
            if (result?.reason) {
                const explain = text.reason[result.reason];
                item.append(make('p', 'twpe-test-run__message',
                    explain(test, options.frameLimit ?? DEFAULT_FRAME_LIMIT, result.message ?? '')));
            }
            list.append(item);
        }
        runAllButton.disabled = controller !== null;
        stopButton.disabled = controller === null;
    };

    const setSummary = (message: string) => {
        summary.textContent = message;
    };

    const summarize = () => {
        const shown = tests.map(test => results.get(test.address)).filter((result): result is TestResult => Boolean(result));
        if (!shown.length) return setSummary('');
        const counts: Record<TestStatus, number> = {passed: 0, failed: 0, 'timed-out': 0, error: 0};
        for (const result of shown) counts[result.status]++;
        setSummary(text.summary(counts, shown.length));
    };

    const listFrom = (project: Project): boolean => {
        if (project instanceof ArrayBuffer) {
            listed = tests.length > 0;
            return false;
        }
        listed = true;
        tests = discoverTests(project).tests;
        // Results of tests that no longer exist would only mislead.
        for (const address of [...results.keys()]) {
            if (!tests.some(test => test.address === address)) results.delete(address);
        }
        return true;
    };

    const start = async (only?: string[]) => {
        if (controller || disposed) return;
        const project = await options.getProject();
        const known = listFrom(options.listProject ? await options.listProject() : project);
        if (!known && tests.length === 0) setSummary(text.cannotList);
        controller = new AbortController();
        const signal = controller.signal;
        if (only) for (const address of only) results.delete(address);
        else results.clear();
        render();
        setSummary(text.running);
        try {
            runner ??= (async () => {
                if (options.createRunner) return options.createRunner(stage);
                if (options.createVm) return vmRunner(await options.createVm(stage));
                throw new Error('The test run view needs createRunner or createVm.');
            })();
            await (await runner).run({
                project, only, frameLimit: options.frameLimit, signal,
                onTestStart: test => {
                    listed = true;
                    if (!tests.some(known => known.address === test.address)) tests.push(test);
                    runningAddress = test.address;
                    render();
                },
                onTestEnd: result => {
                    results.set(result.address, result);
                    runningAddress = null;
                    render();
                }
            });
            controller = null;
            runningAddress = null;
            // The run has seen every test there is, even when there were none.
            if (!only) listed = true;
            render();
            summarize();
        } catch (error) {
            controller = null;
            runningAddress = null;
            render();
            if (signal.aborted) setSummary(text.stopped);
            else setSummary(error instanceof Error ? error.message : String(error));
        }
    };

    runAllButton.addEventListener('click', () => void view.runAll());
    stopButton.addEventListener('click', () => view.stop());

    const view: TestRunView = {
        element: root,
        async refresh() {
            if (controller) return;
            const known = listFrom(options.listProject ? await options.listProject() : await options.getProject());
            render();
            if (known) summarize();
            else setSummary(text.cannotList);
        },
        runAll: () => start(),
        run: address => start([address]),
        stop() {
            controller?.abort();
        },
        dispose() {
            disposed = true;
            controller?.abort();
            void runner?.then(port => port.dispose?.(), () => undefined);
            root.remove();
        }
    };
    render();
    return view;
}

/** The ▼ menu item of the run view button that opens this view, for the workbench's `menuItems`. */
export function testRunMenuItem(locale: string, open: () => void) {
    return {id: 'open-test-run-view', label: testRunText(locale).open, onSelect: open};
}

/**
 * The workspace tab that holds the view, in the shape of the workbench's `DocumentPanelRequest`. The tab is transient:
 * it is not saved with the layout, and closing it stops the run.
 */
export function testRunPanelRequest(options: TestRunViewOptions) {
    const title = testRunText(options.locale).title;
    return {
        reference: testRunViewReference,
        filename: title,
        title,
        transient: true,
        mount(slot: HTMLElement, close: () => void) {
            const view = createTestRunView({...options, document: slot.ownerDocument});
            slot.append(view.element);
            void view.refresh();
            return {requestClose: close, dispose: () => view.dispose()};
        }
    };
}
