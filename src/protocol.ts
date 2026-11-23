// SPDX-License-Identifier: MPL-2.0
/**
 * The contract with the TurboWarp-Test extension (kubohiroya/turbowarp-test, `src/protocol.ts`). The extension
 * emits one record on the VM runtime for every check; this package only listens, so it never loads the extension.
 */

export const TEST_EXTENSION_ID = 'kubohiroyatest';
export const TEST_HAT_OPCODE = `${TEST_EXTENSION_ID}_whentest`;
export const SETUP_HAT_OPCODE = `${TEST_EXTENSION_ID}_whensetup`;
export const ASSERTION_EVENT = 'KUBOHIROYATEST_ASSERTION';

export type AssertionKind =
    | 'strict-equals'
    | 'equals'
    | 'true'
    | 'close'
    | 'list-equals'
    | 'eventually'
    | 'wait-until';

export interface AssertionRecord {
    kind: AssertionKind;
    passed: boolean;
    /** The check block. */
    blockId: string | null;
    /** The top block of the script that ran the check. */
    topBlockId: string | null;
    targetId: string | null;
    frame: number;
    actual?: unknown;
    expected?: unknown;
    tolerance?: number;
    message?: string;
}
