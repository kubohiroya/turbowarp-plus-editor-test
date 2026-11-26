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

/** Digest of the executable artifact selected by the host for one extension in the test snapshot. */
export interface TestBuildIdentity {
    extensionId: string;
    sha256: string;
}

/** Copy the host's attribution before any async work; the same snapshot applies to every result of a run. */
export function captureTestBuilds(builds: readonly TestBuildIdentity[] | undefined): readonly TestBuildIdentity[] | undefined {
    if (builds === undefined) return undefined;
    if (!Array.isArray(builds)) throw new TypeError('Test build identities must be an array.');
    const ids = new Set<string>();
    return Object.freeze(builds.map(build => {
        if (!build || typeof build.extensionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(build.extensionId) ||
            typeof build.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(build.sha256) || ids.has(build.extensionId)) {
            throw new TypeError('Invalid or duplicate test build identity.');
        }
        ids.add(build.extensionId);
        return Object.freeze({extensionId: build.extensionId, sha256: build.sha256});
    }).sort((left, right) => left.extensionId < right.extensionId ? -1 : left.extensionId > right.extensionId ? 1 : 0));
}
