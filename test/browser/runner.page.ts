// The test page for runner.browser.ts: the Editor's pinned VM running the fixture project.
import {runTests, toJUnitXml} from '../../dist/index.js';
import {extension, project} from './fixture.ts';

declare const EditorRuntime: any;

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
