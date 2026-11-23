// SPDX-License-Identifier: MPL-2.0
/** A test run as JUnit XML, for CI. Each sprite or stage is a suite; each test is a case. */
import type {AssertionRecord} from './protocol.ts';
import type {TestResult, TestRunReport} from './test-runner.ts';

const escape = (text: string) => text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Characters XML 1.0 cannot carry at all.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const show = (value: unknown) => JSON.stringify(value) ?? String(value);

function describeFailure(record: AssertionRecord): string {
    const parts = [`${record.kind} at block ${record.blockId ?? '?'}`];
    if ('expected' in record) parts.push(`expected ${show(record.expected)}`);
    if ('actual' in record) parts.push(`actual ${show(record.actual)}`);
    if (record.tolerance !== undefined) parts.push(`tolerance ${show(record.tolerance)}`);
    if (record.message) parts.push(record.message);
    return parts.join(', ');
}

function testCase(result: TestResult): string {
    const name = result.name || result.blockId;
    const open = `    <testcase classname="${escape(result.target)}" name="${escape(name)}" ` +
        `time="${(result.durationMs / 1000).toFixed(3)}">`;
    const properties = `      <properties><property name="address" value="${escape(result.address)}"/>` +
        `<property name="frames" value="${result.frames}"/></properties>`;
    const failures = result.assertions.filter(record => !record.passed);
    const body: string[] = [properties];
    if (result.status === 'failed') {
        const message = failures.map(describeFailure).join('\n') || result.message || 'failed';
        body.push(`      <failure message="${escape(failures[0] ? describeFailure(failures[0]) : message)}">` +
            `${escape(message)}</failure>`);
    } else if (result.status === 'timed-out' || result.status === 'error') {
        body.push(`      <error type="${result.status}" message="${escape(result.message ?? result.status)}"/>`);
    }
    return [open, ...body, '    </testcase>'].join('\n');
}

export function toJUnitXml(report: TestRunReport, suiteName = 'turbowarp-plus-editor-test'): string {
    const byTarget = new Map<string, TestResult[]>();
    for (const result of report.results) {
        byTarget.set(result.target, [...byTarget.get(result.target) ?? [], result]);
    }
    const suites = [...byTarget].map(([target, results]) => {
        const count = (status: string) => results.filter(result => result.status === status).length;
        const time = results.reduce((total, result) => total + result.durationMs, 0) / 1000;
        return [
            `  <testsuite name="${escape(target)}" tests="${results.length}" failures="${count('failed')}" ` +
                `errors="${count('timed-out') + count('error')}" time="${time.toFixed(3)}">`,
            ...results.map(testCase),
            '  </testsuite>'
        ].join('\n');
    });
    const {counts} = report;
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<testsuites name="${escape(suiteName)}" tests="${report.results.length}" failures="${counts.failed}" ` +
            `errors="${counts['timed-out'] + counts.error}">`,
        ...suites,
        '</testsuites>',
        ''
    ].join('\n');
}
