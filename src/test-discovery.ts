// SPDX-License-Identifier: MPL-2.0
/** Finds the tests in a project's `project.json`, as `vm.toJSON()` or an SB3 holds it. */
import {SETUP_HAT_OPCODE, TEST_HAT_OPCODE} from './protocol.ts';

export interface DiscoveredTest {
    /** `<target name>/<block ID>`: stable across renaming the test. */
    address: string;
    target: string;
    blockId: string;
    /** For display only. */
    name: string;
}

export interface TestDiscovery {
    tests: DiscoveredTest[];
    /** The "before each test" hat of each target that has one, by target name. */
    setups: Record<string, string>;
    /** Targets with more than one "before each test" hat. Their tests cannot run. */
    duplicateSetups: Record<string, string[]>;
}

type SerializedBlock = {
    opcode?: unknown;
    topLevel?: unknown;
    inputs?: Record<string, unknown>;
    fields?: Record<string, unknown>;
    x?: unknown;
    y?: unknown;
};
type SerializedTarget = {name?: unknown; isStage?: unknown; blocks?: Record<string, unknown>};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** The text of a NAME input: an inline text primitive or a text shadow block. */
function inputText(blocks: Record<string, unknown>, input: unknown): string {
    if (!Array.isArray(input)) return '';
    const value = input[1];
    if (Array.isArray(value)) return typeof value[1] === 'string' ? value[1] : String(value[1] ?? '');
    if (typeof value !== 'string') return '';
    const shadow = blocks[value];
    if (!isRecord(shadow) || !isRecord(shadow.fields)) return '';
    const field = shadow.fields.TEXT;
    return Array.isArray(field) ? String(field[0] ?? '') : '';
}

function hats(blocks: Record<string, unknown>, opcode: string): Array<[string, SerializedBlock]> {
    return Object.entries(blocks)
        .filter((entry): entry is [string, SerializedBlock] => {
            const block = entry[1];
            return isRecord(block) && block.opcode === opcode && block.topLevel === true;
        })
        // Workspace order, top to bottom and left to right, so that the list reads like the code area.
        .sort(([leftId, left], [rightId, right]) =>
            (Number(left.y) || 0) - (Number(right.y) || 0) ||
            (Number(left.x) || 0) - (Number(right.x) || 0) ||
            (leftId < rightId ? -1 : leftId > rightId ? 1 : 0));
}

export function discoverTests(project: unknown): TestDiscovery {
    const parsed = typeof project === 'string' ? JSON.parse(project) as unknown : project;
    if (!isRecord(parsed) || !Array.isArray(parsed.targets)) throw new TypeError('A project must have targets.');
    const discovery: TestDiscovery = {tests: [], setups: {}, duplicateSetups: {}};
    // The stage first, then the sprites in project order, as the sprite list shows them.
    const targets = (parsed.targets as SerializedTarget[]).filter(isRecord)
        .map((target, index) => ({target, index}))
        .sort((left, right) => Number(Boolean(right.target.isStage)) - Number(Boolean(left.target.isStage)) ||
            left.index - right.index)
        .map(({target}) => target);
    for (const target of targets) {
        if (typeof target.name !== 'string' || !isRecord(target.blocks)) continue;
        const blocks = target.blocks;
        const setups = hats(blocks, SETUP_HAT_OPCODE).map(([blockId]) => blockId);
        if (setups.length === 1) discovery.setups[target.name] = setups[0]!;
        if (setups.length > 1) discovery.duplicateSetups[target.name] = setups;
        for (const [blockId, block] of hats(blocks, TEST_HAT_OPCODE)) {
            discovery.tests.push({
                address: `${target.name}/${blockId}`,
                target: target.name,
                blockId,
                name: inputText(blocks, block.inputs?.NAME)
            });
        }
    }
    return discovery;
}
