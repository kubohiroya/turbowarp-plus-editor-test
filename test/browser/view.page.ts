// The test page for view.browser.ts: the test run view on the Editor's pinned VM, running the fixture project.
import {createTestRunView, testRunMenuItem, testRunPanelRequest} from '../../dist/index.js';
import {extension, project} from './fixture.ts';

declare const EditorRuntime: any;

(globalThis as any).setup = async ({locale, frameLimit, archive = false, list = false, builds = false}:
    {locale: string; frameLimit: number; archive?: boolean; list?: boolean; builds?: boolean}) => {
    const host = await EditorRuntime.start(document.getElementById('workspace'), {locale: 'en'});
    const vm = host.vm;
    host.registerExtension(extension(EditorRuntime.vmModules.ScratchCommon.Cast, vm.runtime));
    if (vm.runtime.frameLoop?.running) vm.stop();
    const shown: Array<[string, string]> = [];
    const created: HTMLElement[] = [];
    let digest = 'a'.repeat(64);
    const options = {
        document, locale, frameLimit,
        // An archive stands for the SB3 the editor passes, which the view cannot read; only its listing is tested.
        getProject: () => archive ? new ArrayBuffer(8) : structuredClone(project),
        ...(builds ? {getRunSnapshot: () => ({project: structuredClone(project), builds: [
            {extensionId: 'typedclamp', sha256: digest}
        ]})} : {}),
        ...(list ? {listProject: () => JSON.stringify(project)} : {}),
        createVm: (stage: HTMLElement) => {
            created.push(stage);
            return vm;
        },
        showBlock: (target: string, blockId: string) => shown.push([target, blockId])
    };
    const container = document.createElement('div');
    container.id = 'view';
    // Above the runtime's workspace, which fills the page.
    container.style.cssText = 'position: fixed; inset: 0; z-index: 2147483647; background: white; overflow: auto;';
    document.body.append(container);
    const view = createTestRunView(options);
    container.append(view.element);
    await view.refresh();
    const opened: string[] = [];
    (globalThis as any).harness = {
        view,
        shown,
        changeDigest: () => {digest = 'b'.repeat(64);},
        vmCreated: () => created.length,
        menuItem: () => {
            const item = testRunMenuItem(locale, () => opened.push('open'));
            item.onSelect();
            return {id: item.id, label: item.label, opened: opened.length};
        },
        panel: () => {
            const request = testRunPanelRequest(options);
            const slot = document.createElement('div');
            document.body.append(slot);
            let closed = 0;
            const session = request.mount(slot, () => closed++);
            const mounted = slot.querySelectorAll('.twpe-test-run').length;
            session.requestClose();
            session.dispose();
            return {reference: request.reference, title: request.title, transient: request.transient,
                mounted, closed, left: slot.querySelectorAll('.twpe-test-run').length};
        }
    };
};
