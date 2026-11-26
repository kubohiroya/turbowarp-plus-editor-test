// SPDX-License-Identifier: MPL-2.0
/**
 * Running tests in a document of their own. A page holds only one VM that can load extensions through the
 * extension loader, since the loader takes over the page's central dispatch for it; the editor's VM already has it.
 * So the test VM lives in a frame: `serveTestFrame` runs inside it, and `connectTestFrame` is the editor's side.
 * Both only accept messages from the other's window and the agreed origin.
 */
import {captureTestBuilds, type TestBuildIdentity} from './protocol.ts';
import type {DiscoveredTest} from './test-discovery.ts';
import {runTests, type RunnerVM, type TestResult, type TestRunReport} from './test-runner.ts';

export type Project = ArrayBuffer | string | object;

export interface TestRunRequest {
    project: Project;
    builds?: readonly TestBuildIdentity[];
    only?: readonly string[];
    frameLimit?: number;
    signal?: AbortSignal;
    onTestStart?(test: DiscoveredTest): void;
    onTestEnd?(result: TestResult): void;
}

/** Whatever runs tests for the view: a VM in the page, or a frame. */
export interface TestRunnerPort {
    run(request: TestRunRequest): Promise<TestRunReport>;
    dispose?(): void;
}

/** A runner on a VM of this page. */
export function vmRunner(vm: RunnerVM): TestRunnerPort {
    return {run: request => runTests({vm, ...request})};
}

const PREFIX = 'twpe-test:';

// The Editor owns the Test run popup's DOM, but its calls to postMessage still originate in the editor window.
// Use the same-origin opener as the client only for that popup; an embedded tab uses the immediate parent.
const editorClient = (owner: Window, origin: string): Window => {
    if (owner.name !== 'tw-plus-test-run') return owner;
    try {
        const opener: Window | null = owner.opener;
        return opener?.location.origin === origin ? opener : owner;
    } catch {
        return owner;
    }
};

type ToFrame =
    | {type: `${typeof PREFIX}run`; id: string; project: Project; builds?: readonly TestBuildIdentity[]; only?: string[]; frameLimit?: number; context?: unknown}
    | {type: `${typeof PREFIX}stop`; id: string};
type FromFrame =
    | {type: `${typeof PREFIX}ready`}
    | {type: `${typeof PREFIX}start`; id: string; test: DiscoveredTest}
    | {type: `${typeof PREFIX}end`; id: string; result: TestResult}
    | {type: `${typeof PREFIX}done`; id: string; report: TestRunReport}
    | {type: `${typeof PREFIX}failed`; id: string; message: string; aborted: boolean};

const isMessage = (data: unknown): data is {type: string; id?: string} =>
    typeof data === 'object' && data !== null && typeof (data as {type?: unknown}).type === 'string' &&
    (data as {type: string}).type.startsWith(PREFIX);

export interface TestFrameServerOptions {
    window: Window;
    /** The editor's origin. Messages from anywhere else are ignored. */
    origin: string;
    /** The test VM, created on the first run. */
    getVm(): RunnerVM | Promise<RunnerVM>;
    /** Supplies authoritative evidence from the VM that loaded the test project. */
    getLoadedBuilds?: Parameters<typeof runTests>[0]['getLoadedBuilds'];
    /**
     * Called before each run with what the editor sent along, such as the extension code it trusts, so that the
     * frame loads only that. A rejection fails the run.
     */
    prepare?(context: unknown, vm: RunnerVM): void | Promise<void>;
}

/** Inside the frame: runs what the editor asks for, one run at a time, and reports as it goes. */
export function serveTestFrame(options: TestFrameServerOptions): () => void {
    const {window} = options;
    const client = editorClient(window.parent, options.origin);
    const post = (message: FromFrame) => client.postMessage(message, options.origin);
    const runs = new Map<string, AbortController>();
    let vm: Promise<RunnerVM> | undefined;
    let queue: Promise<unknown> = Promise.resolve();

    const run = async (message: Extract<ToFrame, {type: 'twpe-test:run'}>) => {
        const controller = new AbortController();
        runs.set(message.id, controller);
        try {
            vm ??= Promise.resolve(options.getVm());
            const testVm = await vm;
            controller.signal.throwIfAborted();
            const builds = options.getLoadedBuilds ? undefined : captureTestBuilds(message.builds);
            await options.prepare?.(message.context, testVm);
            const report = await runTests({
                vm: testVm, project: message.project, builds, getLoadedBuilds: options.getLoadedBuilds, only: message.only, frameLimit: message.frameLimit,
                signal: controller.signal,
                onTestStart: test => post({type: `${PREFIX}start`, id: message.id, test}),
                onTestEnd: result => post({type: `${PREFIX}end`, id: message.id, result})
            });
            post({type: `${PREFIX}done`, id: message.id, report});
        } catch (error) {
            post({type: `${PREFIX}failed`, id: message.id, aborted: controller.signal.aborted,
                message: error instanceof Error ? error.message : String(error)});
        } finally {
            runs.delete(message.id);
        }
    };

    const listener = (event: MessageEvent) => {
        if (event.source !== client || event.origin !== options.origin || !isMessage(event.data)) return;
        const message = event.data as ToFrame;
        if (message.type === `${PREFIX}stop`) {
            runs.get(message.id)?.abort();
        } else if (message.type === `${PREFIX}run` && typeof message.id === 'string') {
            // One VM, so runs wait for each other.
            queue = queue.then(() => run(message));
        }
    };
    window.addEventListener('message', listener);
    post({type: `${PREFIX}ready`});
    return () => {
        window.removeEventListener('message', listener);
        for (const controller of runs.values()) controller.abort();
    };
}

export interface TestFrameClientOptions {
    /** The frame's origin. Messages from anywhere else are ignored. */
    origin: string;
    /** What accompanies this request, such as the extension code approved for its project snapshot. */
    context?(request: TestRunRequest): unknown;
}

/** The editor's side of a frame that runs `serveTestFrame`. */
export function connectTestFrame(frame: HTMLIFrameElement, options: TestFrameClientOptions): TestRunnerPort {
    const window = editorClient(frame.ownerDocument.defaultView!, options.origin);
    let readyResolve!: () => void;
    const ready = new Promise<void>(resolve => {
        readyResolve = resolve;
    });
    type Pending = {request: TestRunRequest; resolve(report: TestRunReport): void; reject(error: unknown): void};
    const pending = new Map<string, Pending>();
    let counter = 0;

    const listener = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow || event.origin !== options.origin || !isMessage(event.data)) return;
        const message = event.data as FromFrame;
        if (message.type === `${PREFIX}ready`) {
            readyResolve();
            return;
        }
        const entry = pending.get(message.id);
        if (!entry) return;
        if (message.type === `${PREFIX}start`) entry.request.onTestStart?.(message.test);
        else if (message.type === `${PREFIX}end`) entry.request.onTestEnd?.(message.result);
        else if (message.type === `${PREFIX}done`) {
            pending.delete(message.id);
            entry.resolve(message.report);
        } else if (message.type === `${PREFIX}failed`) {
            pending.delete(message.id);
            entry.reject(message.aborted ? new DOMException('The run was stopped.', 'AbortError') : new Error(message.message));
        }
    };
    window.addEventListener('message', listener);

    return {
        async run(request) {
            request.signal?.throwIfAborted();
            const builds = captureTestBuilds(request.builds);
            const context = options.context?.(request);
            const project = builds === undefined ? request.project : structuredClone(request.project);
            await ready;
            request.signal?.throwIfAborted();
            const id = `run-${++counter}`;
            const target = frame.contentWindow;
            if (!target) throw new Error('The test frame is gone.');
            return new Promise<TestRunReport>((resolve, reject) => {
                pending.set(id, {request, resolve, reject});
                request.signal?.addEventListener('abort', () => {
                    target.postMessage({type: `${PREFIX}stop`, id} satisfies ToFrame, options.origin);
                }, {once: true});
                target.postMessage({
                    type: `${PREFIX}run`, id, project,
                    ...(builds === undefined ? {} : {builds}),
                    ...(request.only ? {only: [...request.only]} : {}),
                    ...(request.frameLimit === undefined ? {} : {frameLimit: request.frameLimit}),
                    ...(context === undefined ? {} : {context})
                } satisfies ToFrame, options.origin);
            });
        },
        dispose() {
            window.removeEventListener('message', listener);
            for (const entry of pending.values()) entry.reject(new DOMException('The test frame was closed.', 'AbortError'));
            pending.clear();
        }
    };
}
