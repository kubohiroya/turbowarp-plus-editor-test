import assert from 'node:assert/strict';
import {test} from 'node:test';
import {toJUnitXml} from '../dist/junit.js';

const result = (fields: Record<string, unknown>) => ({
    address: 'Cat/t', target: 'Cat', blockId: 't', name: 'counts <scenes>', frames: 3, assertions: [], durationMs: 12, ...fields
});

test('writes one suite per target with failures and errors', () => {
    const report = {
        results: [
            result({status: 'passed'}),
            result({address: 'Cat/f', blockId: 'f', name: 'fails', status: 'failed', assertions: [
                {kind: 'strict-equals', passed: false, blockId: 'check', topBlockId: 'f', targetId: 'x', frame: 1, actual: '1', expected: 1}
            ]}),
            result({address: 'Stage/s', target: 'Stage', blockId: 's', name: '', status: 'timed-out', message: 'The test ran for 10 frames.'})
        ],
        counts: {passed: 1, failed: 1, 'timed-out': 1, error: 0},
        ok: false
    };
    const xml = toJUnitXml(report as never);
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites name="turbowarp-plus-editor-test" tests="3" failures="1" errors="1">/);
    assert.match(xml, /<testsuite name="Cat" tests="2" failures="1" errors="0" time="0.024">/);
    assert.match(xml, /name="counts &lt;scenes&gt;"/);
    assert.match(xml, /<failure message="strict-equals at block check, expected 1, actual &quot;1&quot;">/);
    assert.match(xml, /<testsuite name="Stage" tests="1" failures="0" errors="1"/);
    // A test without a name is named by its block.
    assert.match(xml, /<testcase classname="Stage" name="s"/);
    assert.match(xml, /<error type="timed-out" message="The test ran for 10 frames."\/>/);
    assert.match(xml, /<property name="address" value="Cat\/f"\/>/);
});
