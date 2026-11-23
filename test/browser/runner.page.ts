// The test page for runner.browser.ts: the Editor's pinned VM, a minimal extension that speaks the TurboWarp-Test
// protocol, and a project whose tests check that every test starts from a fresh copy.
import {runTests, toJUnitXml} from '../../dist/index.js';

declare const EditorRuntime: any;

type Block = Record<string, unknown>;
const text = (value: string) => [1, [10, value]];

const script = (x: number, ...stack: Array<[string, Block]>): Record<string, Block> => Object.fromEntries(
    stack.map(([id, block], index) => [id, {
        fields: {}, inputs: {}, shadow: false, ...block,
        next: stack[index + 1]?.[0] ?? null,
        parent: index === 0 ? null : stack[index - 1]![0],
        topLevel: index === 0,
        ...(index === 0 ? {x, y: 0} : {})
    }]));
const child = (parent: string, block: Block): Block => ({fields: {}, inputs: {}, shadow: false, next: null, topLevel: false, parent, ...block});
const variable = (name: string) => [3, [12, name, `${name}Id`], [10, '']];
const test = (id: string, name: string, x: number, ...body: Array<[string, Block]>) =>
    script(x, [id, {opcode: 'kubohiroyatest_whentest', inputs: {NAME: text(name)}}], ...body);
const assertEquals = (id: string, name: string, value: string) => ({
    [id]: {opcode: 'kubohiroyatest_assert_true', inputs: {CONDITION: [2, `${id}Eq`]}},
    [`${id}Eq`]: child(id, {opcode: 'operator_equals', inputs: {OPERAND1: variable(name), OPERAND2: text(value)}})
});

const sprite = (name: string, layerOrder: number, blocks: Record<string, Block>, variables = {}) => ({
    isStage: false, name, variables, lists: {}, broadcasts: {}, comments: {}, blocks,
    currentCostume: 0, costumes: [], sounds: [], volume: 100, layerOrder, visible: true,
    x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around'
});

const visitTest = (id: string, name: string, x: number) => {
    const checkId = `${id}Check`;
    const {[checkId]: checkBlock, ...rest} = assertEquals(checkId, 'visits', '1');
    return {
        ...script(x,
            [id, {opcode: 'kubohiroyatest_whentest', inputs: {NAME: text(name)}}],
            [`${id}Visit`, {opcode: 'data_changevariableby', fields: {VARIABLE: ['visits', 'visitsId']}, inputs: {VALUE: [1, [4, '1']]}}],
            [`${id}Count`, {opcode: 'kubohiroyatest_assert_true', inputs: {CONDITION: [2, `${id}CountEq`]}}],
            [checkId, checkBlock as Block]),
        [`${id}CountEq`]: child(`${id}Count`, {opcode: 'operator_equals', inputs: {OPERAND1: variable('count'), OPERAND2: text('10')}}),
        ...rest
    };
};

const project = {
    meta: {semver: '3.0.0', vm: '0.2.0', agent: ''},
    extensions: ['kubohiroyatest'],
    monitors: [],
    targets: [
        {isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
            currentCostume: 0, costumes: [], sounds: [], volume: 100, layerOrder: 0},
        sprite('Cat', 1, {
            ...script(0,
                ['flag', {opcode: 'event_whenflagclicked'}],
                ['flagSet', {opcode: 'data_setvariableto', fields: {VARIABLE: ['visits', 'visitsId']}, inputs: {VALUE: text('999')}}]),
            ...script(200,
                ['setup', {opcode: 'kubohiroyatest_whensetup'}],
                ['setupSet', {opcode: 'data_setvariableto', fields: {VARIABLE: ['count', 'countId']}, inputs: {VALUE: text('10')}}]),
            ...visitTest('first', 'first visit', 400),
            ...visitTest('second', 'second visit', 600),
            ...test('failing', 'fails', 800,
                ['failingCheck', {opcode: 'kubohiroyatest_assert_true', inputs: {CONDITION: [2, 'failingEq']}}],
                ['failingAfter', {opcode: 'data_setvariableto', fields: {VARIABLE: ['visits', 'visitsId']}, inputs: {VALUE: text('5')}}]),
            failingEq: child('failingCheck', {opcode: 'operator_equals', inputs: {OPERAND1: text('a'), OPERAND2: text('b')}}),
            ...test('forever', 'never ends', 1000, ['loop', {opcode: 'control_forever', inputs: {}}])
        }, {visitsId: ['visits', 0], countId: ['count', 0]}),
        sprite('Twice', 2, {
            ...script(0, ['setupA', {opcode: 'kubohiroyatest_whensetup'}]),
            ...script(200, ['setupB', {opcode: 'kubohiroyatest_whensetup'}]),
            ...test('twiceTest', 'cannot run', 400)
        })
    ]
};

const extension = (Cast: any, runtime: any) => ({
    getInfo: () => ({
        id: 'kubohiroyatest',
        name: 'Test',
        blocks: [
            {opcode: 'whentest', blockType: 'hat', isEdgeActivated: false, text: 'test [NAME]', arguments: {NAME: {type: 'string', defaultValue: ''}}},
            {opcode: 'whensetup', blockType: 'hat', isEdgeActivated: false, text: 'before each test', arguments: {}},
            {opcode: 'assert_true', blockType: 'command', text: 'check [CONDITION]', arguments: {CONDITION: {type: 'Boolean'}}}
        ]
    }),
    whentest: () => true,
    whensetup: () => true,
    assert_true(args: any, util: any) {
        const passed = Cast.toBoolean(args.CONDITION);
        runtime.emit('KUBOHIROYATEST_ASSERTION', {kind: 'true', passed, blockId: util.thread.peekStack(),
            topBlockId: util.thread.topBlock, targetId: util.target.id, frame: 0, actual: passed, expected: true});
        if (!passed) util.stopThisScript();
    }
});

(globalThis as any).run = async ({only, frameLimit}: {only?: string[]; frameLimit?: number}) => {
    const host = await EditorRuntime.start(document.getElementById('workspace'), {locale: 'en'});
    const vm = host.vm;
    host.registerExtension(extension(EditorRuntime.vmModules.ScratchCommon.Cast, vm.runtime));
    if (vm.runtime.frameLoop?.running) vm.stop();
    const started: string[] = [];
    const report = await runTests({vm, project, only, frameLimit, onTestStart: test => started.push(test.address)});
    const visits = vm.runtime.targets.find((target: any) => target.getName?.() === 'Cat')
        ?.lookupVariableByNameAndType('visits', '').value;
    return {report, started, junit: toJUnitXml(report), visits};
};
