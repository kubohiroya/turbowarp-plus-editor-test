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

test('accepts build attribution by run and keeps earlier results on their original digest', async () => {
    const {parent, frame, sent} = frameWindows();
    const dispose = serveTestFrame({window: frame as never, origin: ORIGIN, getVm: fakeVm});
    const first = [{extensionId: 'typedclamp', sha256: 'a'.repeat(64)}];
    const second = [{extensionId: 'typedclamp', sha256: 'b'.repeat(64)}];
    message(frame, {type: 'twpe-test:run', id: 'old', project: {}, builds: first}, ORIGIN, parent);
    message(frame, {type: 'twpe-test:run', id: 'new', project: {}, builds: second}, ORIGIN, parent);
    for (let tries = 0; tries < 50 && sent.filter(entry => entry.data.type === 'twpe-test:done').length < 2; tries++) {
        await settle();
    }
    const results = sent.filter(entry => entry.data.type === 'twpe-test:end').map(({data}) => [data.id, data.result.builds]);
    const reports = sent.filter(entry => entry.data.type === 'twpe-test:done').map(({data}) => [data.id, data.report.builds]);
    assert.deepEqual(results, [['old', first], ['new', second]]);
    assert.deepEqual(reports, results);
    dispose();
});

test('captures build attribution before waiting for the frame and rejects malformed or duplicate identities', async () => {
    const editor = new EventTarget();
    const posted: any[] = [];
    const contentWindow = {postMessage: (data: unknown) => posted.push(data)};
    const port = connectTestFrame({ownerDocument: {defaultView: editor}, contentWindow} as never, {origin: ORIGIN});
    const builds = [{extensionId: 'typedclamp', sha256: 'a'.repeat(64)}];
    const project = {name: 'old'};
    const running = port.run({project, builds});
    project.name = 'new';
    builds[0]!.sha256 = 'b'.repeat(64);
    message(editor, {type: 'twpe-test:ready'}, ORIGIN, contentWindow);
    await settle();
    assert.deepEqual(posted[0].builds, [{extensionId: 'typedclamp', sha256: 'a'.repeat(64)}]);
    assert.deepEqual(posted[0].project, {name: 'old'});
    message(editor, {type: 'twpe-test:done', id: 'run-1', report: {ok: true}}, ORIGIN, contentWindow);
    await running;
    await assert.rejects(port.run({project: {}, builds: [...builds, ...builds]}), /duplicate/);
    await assert.rejects(port.run({project: {}, builds: [{extensionId: 'typedclamp', sha256: 'wrong'}]}), /Invalid/);
    assert.equal(posted.length, 1);
    port.dispose?.();
});

test('only authoritative VM identities label results after each exact project load', async () => {
    const {parent, frame, sent} = frameWindows();
    const vm = fakeVm();
    let loads = 0;
    vm.loadProject = async () => {loads++;};
    vm.toJSON = () => JSON.stringify({targets: [{name: 'Cat', blocks: Object.fromEntries(
        ['first', 'second'].map(id => [id, {opcode: 'kubohiroyatest_whentest', topLevel: true}])
    )}]});
    const digests: number[] = [];
    const dispose = serveTestFrame({window: frame as never, origin: ORIGIN, getVm: () => vm, getLoadedBuilds: current => {
        assert.equal(current, vm);
        digests.push(loads);
        return [{extensionId: 'typedclamp', sha256: String(loads).repeat(64)}];
    }});
    message(frame, {type: 'twpe-test:run', id: 'r', project: {},
        builds: [{extensionId: 'typedclamp', sha256: 'a'.repeat(64)}]}, ORIGIN, parent);
    for (let tries = 0; tries < 50 && !sent.some(entry => entry.data.type === 'twpe-test:done'); tries++) await settle();
    const report = sent.find(({data}) => data.type === 'twpe-test:done')?.data.report;
    assert.deepEqual(digests, [2, 3], 'not called for discovery, called after each test load');
    assert.deepEqual(report.results.map(result => result.builds[0].sha256), ['2'.repeat(64), '3'.repeat(64)]);
    assert.equal(Object.hasOwn(report, 'builds'), false, 'different builds cannot label the run as a whole');
    dispose();
});

test('the published popup route still accepts the same-origin opener and rejects another window', async () => {
    const sent: any[] = [];
    const opener = {location: {origin: ORIGIN}, postMessage: (data: unknown) => sent.push(data)};
    const parent = {name: 'tw-plus-test-run', opener, postMessage() {throw new Error('Wrong client');}};
    const frame = Object.assign(new EventTarget(), {parent});
    const dispose = serveTestFrame({window: frame as never, origin: ORIGIN, getVm: fakeVm});
    const run = {type: 'twpe-test:run', id: 'popup', project: {}};
    message(frame, run, ORIGIN, parent);
    await settle();
    assert.deepEqual(sent, [{type: 'twpe-test:ready'}]);
    message(frame, run, ORIGIN, opener);
    for (let tries = 0; tries < 50 && !sent.some(data => data.type === 'twpe-test:done'); tries++) await settle();
    assert.equal(sent.at(-1).report.counts.passed, 1);
    dispose();
});
