// The test page for frame.browser.ts. Loaded with ?frame=1 it is the test frame: a VM of its own, as the editor's
// test frame has. Otherwise it is the editor's side: the test run view, running tests through that frame.
import {connectTestFrame, createTestRunView, serveTestFrame} from '../../dist/index.js';
import {extension, project} from './fixture.ts';

declare const EditorRuntime: any;

if (new URLSearchParams(location.search).has('frame')) {
    const contexts: unknown[] = [];
    (globalThis as any).contexts = contexts;
    serveTestFrame({
        window, origin: location.origin,
        async getVm() {
            const host = await EditorRuntime.start(document.getElementById('workspace'), {locale: 'en'});
            host.registerExtension(extension(EditorRuntime.vmModules.ScratchCommon.Cast, host.vm.runtime));
            if (host.vm.runtime.frameLoop?.running) host.vm.stop();
            return host.vm;
        },
        prepare(context: any) {
            contexts.push(context);
            if (context?.refuse) throw new Error('This code is not trusted.');
        }
    });
} else {
    (globalThis as any).setup = async ({locale, frameLimit, refuse = false}: {locale: string; frameLimit: number; refuse?: boolean}) => {
        const container = document.createElement('div');
        container.id = 'view';
        // Above the runtime's workspace, which fills the page.
        container.style.cssText = 'position: fixed; inset: 0; z-index: 2147483647; background: white; overflow: auto;';
        document.body.append(container);
        const frames: HTMLIFrameElement[] = [];
        const view = createTestRunView({
            document, locale, frameLimit,
            getProject: () => structuredClone(project),
            createRunner(stage: HTMLElement) {
                const frame = document.createElement('iframe');
                frame.src = `${location.pathname}?frame=1`;
                frame.style.cssText = 'width: 100%; height: 100%; border: 0;';
                stage.append(frame);
                frames.push(frame);
                return connectTestFrame(frame, {origin: location.origin, context: () => ({digests: ['0'.repeat(64)], refuse})});
            }
        });
        container.append(view.element);
        await view.refresh();
        (globalThis as any).harness = {
            view,
            frames: () => frames.length,
            contexts: () => (frames[0]?.contentWindow as any)?.contexts ?? []
        };
    };
}
