import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connectTestFrame, serveTestFrame} from '../dist/test-frame.js';

const ORIGIN = 'https://editor.example';
const message = (target: EventTarget, data: unknown, origin: string, source: unknown) =>
    target.dispatchEvent(Object.assign(new Event('message'), {data, origin, source}));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** A VM with one test, `Cat/t`, whose check passes. */
function fakeVm() {
    const listeners = new Map<string, (record: unknown) => void>();
    const target = {id: 'cat', isOriginal: true, isStage: false, getName: () => 'Cat'};
    const runtime = {
        targets: [target],
        threads: [] as Array<{topBlock: string; target: unknown}>,
        _step() {
            for (const thread of runtime.threads.splice(0)) {
                listeners.get('KUBOHIROYATEST_ASSERTION')?.({kind: 'true', passed: true, blockId: 'check',
                    topBlockId: thread.topBlock, targetId: 'cat', frame: 1});
            }
        },
        on: (event: string, listener: (record: unknown) => void) => listeners.set(event, listener),
        removeListener: (event: string) => listeners.delete(event),
        toggleScript: (topBlock: string, {target: owner}: {target: unknown}) => runtime.threads.push({topBlock, target: owner}),
        stopAll() {}
    };
    return {
        runtime,
        loadProject: async () => undefined,
        toJSON: () => JSON.stringify({targets: [{name: 'Cat', blocks: {t: {opcode: 'kubohiroyatest_whentest', topLevel: true}}}]}),
        setCompilerOptions() {}
    };
}

function frameWindows() {
    const sent: Array<{data: any; origin: string}> = [];
    const parent = Object.assign(new EventTarget(), {postMessage: (data: unknown, origin: string) => sent.push({data, origin})});
    const frame = Object.assign(new EventTarget(), {parent});
    return {parent, frame, sent};
}

test('the frame runs only what its parent at the agreed origin asks for', async () => {
    const {parent, frame, sent} = frameWindows();
    const contexts: unknown[] = [];
    const dispose = serveTestFrame({window: frame as never, origin: ORIGIN, getVm: fakeVm, prepare: context => {
        contexts.push(context);
    }});
    assert.deepEqual(sent, [{data: {type: 'twpe-test:ready'}, origin: ORIGIN}]);
    const run = {type: 'twpe-test:run', id: 'r1', project: {}, context: {digests: []}};
    message(frame, run, 'https://elsewhere.example', parent);
    message(frame, run, ORIGIN, {});
    await settle();
    assert.equal(sent.length, 1, 'ignored a run from another origin or window');
    message(frame, run, ORIGIN, parent);
    for (let tries = 0; tries < 50 && !sent.some(entry => entry.data.type === 'twpe-test:done'); tries++) await settle();
    assert.deepEqual(sent.slice(1).map(entry => [entry.data.type, entry.origin]), [
        ['twpe-test:start', ORIGIN], ['twpe-test:end', ORIGIN], ['twpe-test:done', ORIGIN]
    ]);
    assert.equal(sent.at(-1)!.data.report.counts.passed, 1);
    assert.deepEqual(contexts, [{digests: []}]);
    dispose();
});

test('the editor side takes reports only from its frame at the agreed origin', async () => {
    const editor = new EventTarget();
    const posted: unknown[] = [];
    const contentWindow = {postMessage: (data: unknown) => posted.push(data)};
    const frame = {ownerDocument: {defaultView: editor}, contentWindow};
    const port = connectTestFrame(frame as never, {origin: ORIGIN, context: () => 'context'});
    const ended: string[] = [];
    const running = port.run({project: {}, onTestEnd: result => ended.push(result.address)});
    message(editor, {type: 'twpe-test:ready'}, ORIGIN, contentWindow);
    await settle();
    assert.deepEqual(posted, [{type: 'twpe-test:run', id: 'run-1', project: {}, context: 'context'}]);
    const report = {results: [], counts: {passed: 0, failed: 0, 'timed-out': 0, error: 0}, ok: true};
    message(editor, {type: 'twpe-test:end', id: 'run-1', result: {address: 'Cat/x'}}, 'https://elsewhere.example', contentWindow);
    message(editor, {type: 'twpe-test:done', id: 'run-1', report: {forged: true}}, ORIGIN, {});
    message(editor, {type: 'twpe-test:end', id: 'run-1', result: {address: 'Cat/t'}}, ORIGIN, contentWindow);
    message(editor, {type: 'twpe-test:done', id: 'run-1', report}, ORIGIN, contentWindow);
    assert.deepEqual(await running, report);
    assert.deepEqual(ended, ['Cat/t']);
    port.dispose?.();
});

test('stopping on the editor side asks the frame to stop and ends the run', async () => {
    const editor = new EventTarget();
    const posted: any[] = [];
    const contentWindow = {postMessage: (data: unknown) => posted.push(data)};
    const port = connectTestFrame({ownerDocument: {defaultView: editor}, contentWindow} as never, {origin: ORIGIN});
    message(editor, {type: 'twpe-test:ready'}, ORIGIN, contentWindow);
    const controller = new AbortController();
    const running = port.run({project: {}, signal: controller.signal});
    await settle();
    controller.abort();
    assert.deepEqual(posted.map(data => data.type), ['twpe-test:run', 'twpe-test:stop']);
    message(editor, {type: 'twpe-test:failed', id: 'run-1', message: 'aborted', aborted: true}, ORIGIN, contentWindow);
    await assert.rejects(running, {name: 'AbortError'});
});
