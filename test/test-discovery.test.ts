import assert from 'node:assert/strict';
import {test} from 'node:test';
import {discoverTests} from '../dist/test-discovery.js';

const hat = (opcode: string, extra: Record<string, unknown> = {}) => ({opcode, topLevel: true, next: null, parent: null, ...extra});
const named = (name: string, y = 0) => hat('kubohiroyatest_whentest', {inputs: {NAME: [1, [10, name]]}, x: 0, y});

test('finds tests on the stage first, then sprites in order, top to bottom', () => {
    const discovery = discoverTests({
        targets: [
            {name: 'Stage', isStage: true, blocks: {s1: named('stage test')}},
            {name: 'Cat', blocks: {b: named('second', 200), a: named('first', 10), flag: hat('event_whenflagclicked')}},
            {name: 'Dog', blocks: {}}
        ]
    });
    assert.deepEqual(discovery.tests.map(entry => [entry.address, entry.name]), [
        ['Stage/s1', 'stage test'],
        ['Cat/a', 'first'],
        ['Cat/b', 'second']
    ]);
    assert.deepEqual(discovery.setups, {});
});

test('reads a name from a text shadow and leaves a computed name empty', () => {
    const {tests} = discoverTests(JSON.stringify({targets: [{name: 'Cat', blocks: {
        t: hat('kubohiroyatest_whentest', {inputs: {NAME: [1, 'shadow']}}),
        shadow: {opcode: 'text', fields: {TEXT: ['from shadow', null]}, shadow: true, topLevel: false},
        u: hat('kubohiroyatest_whentest', {inputs: {NAME: [3, 'join', [10, '']]}, y: 50}),
        join: {opcode: 'operator_join', topLevel: false}
    }}]}));
    assert.deepEqual(tests.map(entry => entry.name), ['from shadow', '']);
});

test('ignores hats that are not at the top of a script', () => {
    const {tests} = discoverTests({targets: [{name: 'Cat', blocks: {t: {...named('loose'), topLevel: false}}}]});
    assert.deepEqual(tests, []);
});

test('records one "before each test" per target and flags duplicates', () => {
    const discovery = discoverTests({targets: [
        {name: 'Cat', blocks: {s: hat('kubohiroyatest_whensetup')}},
        {name: 'Dog', blocks: {s1: hat('kubohiroyatest_whensetup', {y: 0}), s2: hat('kubohiroyatest_whensetup', {y: 9})}}
    ]});
    assert.deepEqual(discovery.setups, {Cat: 's'});
    assert.deepEqual(discovery.duplicateSetups, {Dog: ['s1', 's2']});
});

test('refuses something that is not a project', () => {
    assert.throws(() => discoverTests({}), /targets/);
});
