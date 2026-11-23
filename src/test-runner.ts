// SPDX-License-Identifier: MPL-2.0
/**
 * Runs a project's tests on a VM of its own. Every test starts from a fresh copy of the project, so no test sees
 * what another left behind; the target's "before each test" hat runs first. The runner steps the VM one frame at a
 * time in the interpreter and collects the records the TurboWarp-Test extension emits.
 *
 * The VM must be one the runner drives alone: not the editor's, and with its frame loop stopped.
 */
import {ASSERTION_EVENT, type AssertionRecord} from './protocol.ts';
import {discoverTests, type DiscoveredTest} from './test-discovery.ts';

export interface RunnerTarget {
    id: string;
    isOriginal: boolean;
    isStage: boolean;
    getName(): string;
}

export interface RunnerThread {
    topBlock: string;
    target: unknown;
    status?: number;
}

export interface RunnerVM {
    runtime: {
        targets: RunnerTarget[];
        threads: RunnerThread[];
        frameLoop?: {running?: boolean};
        _step(): void;
        on(event: string, listener: (record: AssertionRecord) => void): void;
        removeListener(event: string, listener: (record: AssertionRecord) => void): void;
        toggleScript(topBlockId: string, options: {target: RunnerTarget}): void;
        stopAll(): void;
    };
    loadProject(project: ArrayBuffer | string | object): Promise<unknown>;
    toJSON(targetId?: string, options?: {allowOptimization?: boolean}): string;
    setCompilerOptions(options: {enabled: boolean}): void;
}

export type TestStatus = 'passed' | 'failed' | 'timed-out' | 'error';

/** Why a test timed out or could not run, for a view to put in its own words. */
export type TestFailureReason = 'duplicate-setups' | 'missing-target' | 'setup-timed-out' | 'timed-out' | 'exception';

export interface TestResult extends DiscoveredTest {
    status: TestStatus;
    /** Frames the test itself ran, after its "before each test" hat. */
    frames: number;
    /** Every check the test and its "before each test" hat made, in order. */
    assertions: AssertionRecord[];
    /** Why the test timed out or could not run, in English, as JUnit XML carries it. */
    message?: string;
    reason?: TestFailureReason;
    durationMs: number;
}

export interface TestRunReport {
    results: TestResult[];
    counts: Record<TestStatus, number>;
    /** Whether every test that ran passed. */
    ok: boolean;
}

export interface RunTestsOptions {
    vm: RunnerVM;
    /**
     * The project to copy for every test: an SB3 file, or its `project.json` as text or an object. To mark failures
     * on the editor's blocks, pass `editorVm.toJSON(undefined, {allowOptimization: false})` and attach the editor's
     * storage to the test VM, so that the block IDs match and the assets load without a download.
     */
    project: ArrayBuffer | string | object;
    /** Addresses (`<target>/<block ID>`) of the tests to run. All tests run when omitted. */
    only?: readonly string[];
    /** Frames a test, or a "before each test" hat, may run before it counts as timed out. */
    frameLimit?: number;
    signal?: AbortSignal;
    onTestStart?(test: DiscoveredTest): void;
    onTestEnd?(result: TestResult): void;
}

export const DEFAULT_FRAME_LIMIT = 3000;
const STATUS_DONE = 4;

/** A macrotask, so that promises, timers and the page stay alive between frames. */
const nextTask = () => new Promise<void>(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
    };
    channel.port2.postMessage(null);
});

const copyOf = (project: ArrayBuffer | string | object) =>
    project instanceof ArrayBuffer ? project.slice(0) : typeof project === 'string' ? project : structuredClone(project);

function findTarget(vm: RunnerVM, name: string): RunnerTarget | undefined {
    return vm.runtime.targets.find(target => target.isOriginal && target.getName() === name);
}

function isRunning(vm: RunnerVM, topBlockId: string, target: RunnerTarget): boolean {
    return vm.runtime.threads.some(thread =>
        thread.topBlock === topBlockId && thread.target === target && thread.status !== STATUS_DONE);
}

/** Starts one script and steps until it ends. Returns the frames it took, or null when it ran out of frames. */
async function runScript(vm: RunnerVM, topBlockId: string, target: RunnerTarget, frameLimit: number,
    signal?: AbortSignal): Promise<number | null> {
    vm.runtime.toggleScript(topBlockId, {target});
    for (let frame = 1; frame <= frameLimit; frame++) {
        signal?.throwIfAborted();
        vm.runtime._step();
        if (!isRunning(vm, topBlockId, target)) return frame;
        await nextTask();
    }
    return null;
}

async function runOne(vm: RunnerVM, options: RunTestsOptions, test: DiscoveredTest,
    setups: Record<string, string>, duplicateSetups: Record<string, string[]>): Promise<TestResult> {
    const started = performance.now();
    const assertions: AssertionRecord[] = [];
    const finish = (status: TestStatus, frames: number, reason?: TestFailureReason, message?: string): TestResult => ({
        ...test, status, frames, assertions, ...(reason ? {reason} : {}), ...(message ? {message} : {}),
        durationMs: performance.now() - started
    });
    if (duplicateSetups[test.target]) {
        return finish('error', 0, 'duplicate-setups', `${test.target} has more than one "before each test" hat.`);
    }
    const frameLimit = options.frameLimit ?? DEFAULT_FRAME_LIMIT;
    await vm.loadProject(copyOf(options.project));
    vm.setCompilerOptions({enabled: false});
    const target = findTarget(vm, test.target);
    if (!target) return finish('error', 0, 'missing-target', `No sprite or stage named ${test.target}.`);
    const setup = setups[test.target];
    const scripts = new Set([test.blockId, ...(setup ? [setup] : [])]);
    const listener = (record: AssertionRecord) => {
        if (record.topBlockId && scripts.has(record.topBlockId)) assertions.push(record);
    };
    vm.runtime.on(ASSERTION_EVENT, listener);
    try {
        if (setup) {
            const setupFrames = await runScript(vm, setup, target, frameLimit, options.signal);
            if (setupFrames === null) {
                return finish('timed-out', 0, 'setup-timed-out', `"before each test" ran for ${frameLimit} frames.`);
            }
            if (assertions.some(record => !record.passed)) return finish('failed', 0);
        }
        const frames = await runScript(vm, test.blockId, target, frameLimit, options.signal);
        if (frames === null) {
            return finish(assertions.some(record => !record.passed) ? 'failed' : 'timed-out', frameLimit, 'timed-out',
                `The test ran for ${frameLimit} frames.`);
        }
        return finish(assertions.some(record => !record.passed) ? 'failed' : 'passed', frames);
    } catch (error) {
        if (options.signal?.aborted) throw error;
        return finish('error', 0, 'exception', error instanceof Error ? error.message : String(error));
    } finally {
        vm.runtime.removeListener(ASSERTION_EVENT, listener);
        vm.runtime.stopAll();
    }
}

export async function runTests(options: RunTestsOptions): Promise<TestRunReport> {
    const {vm} = options;
    if (vm.runtime.frameLoop?.running) {
        throw new Error('The test VM must not run its frame loop; the runner steps it.');
    }
    await vm.loadProject(copyOf(options.project));
    // Without the optimization the serializer keeps the block IDs the loaded project has; with it, TurboWarp renumbers
    // block IDs by how often they are referenced, and the tests' IDs would not match the blocks that report.
    const {tests, setups, duplicateSetups} = discoverTests(vm.toJSON(undefined, {allowOptimization: false}));
    const selected = options.only ? options.only.map(address => {
        const test = tests.find(candidate => candidate.address === address);
        if (!test) throw new Error(`No test at ${address}.`);
        return test;
    }) : tests;
    const results: TestResult[] = [];
    for (const test of selected) {
        options.signal?.throwIfAborted();
        options.onTestStart?.(test);
        const result = await runOne(vm, options, test, setups, duplicateSetups);
        results.push(result);
        options.onTestEnd?.(result);
    }
    const counts: Record<TestStatus, number> = {passed: 0, failed: 0, 'timed-out': 0, error: 0};
    for (const result of results) counts[result.status]++;
    return {results, counts, ok: results.every(result => result.status === 'passed')};
}
