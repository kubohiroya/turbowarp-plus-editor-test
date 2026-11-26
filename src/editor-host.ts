// SPDX-License-Identifier: MPL-2.0
// Original Plus Editor test launcher, provided by its rights holder under MPL-2.0.
import {connectTestFrame} from './test-frame.ts';
import {TEST_EXTENSION_ID} from './protocol.ts';
import {createTestRunView, testRunMenuItem, testRunPanelRequest, testRunText} from './test-run-view.ts';

export type TestEditorVM = {
    runtime: {targets: Array<{id: string; isOriginal: boolean; getName(): string}>};
    toJSON(targetId?: string, options?: {allowOptimization?: boolean}): string;
    _saveProjectZip(): {file(name: string, data: string): unknown; generateAsync(options: {type: 'arraybuffer'}): Promise<ArrayBuffer>};
    extensionManager: {getExtensionURLs?(): Record<string, string>};
    setEditingTarget(targetId: string): void;
};

export interface TestEditorPorts {
    document(): Document;
    frameURL(view: Window): string;
    zip: {loadAsync(archive: ArrayBuffer): Promise<{file(name: string): {async(type: 'string'): Promise<string>} | null}>};
    identities(vm: TestEditorVM): readonly {id: string; sha256: string; execution: string}[];
    openPanel(vm: TestEditorVM, request: ReturnType<typeof testRunPanelRequest>): boolean;
    navigation(vm: TestEditorVM): {activate(targetId: string): boolean; centerBlock(blockId: string): void} | undefined;
}

export function createTestRunEditor(ports: TestEditorPorts) {
    const {frameURL, zip: JSZip, identities: getExtensionIdentities} = ports;
    let editorVm: TestEditorVM | null = null;

    /** A one-use runner for a saved archive. It receives no handle or state from the live Editor. */
    const runSavedGenerationTests = async (document: Document, archive: ArrayBuffer, signal: AbortSignal) => {
        const view = document.defaultView!;
        const zip = await JSZip.loadAsync(archive);
        const project = JSON.parse(await zip.file('project.json')!.async('string'));
        const extensionURLs = Object.values(project.extensionURLs ?? {}).filter((url): url is string => typeof url === 'string');
        const declared = project.turboWarpPlus?.extensions;
        const managed = Array.isArray(declared) && declared.some(extension => extension?.id === TEST_EXTENSION_ID);
        const testExtensionURL = managed ? undefined : project.extensionURLs?.[TEST_EXTENSION_ID];
        signal.throwIfAborted();
        const frame = document.createElement('iframe');
        frame.src = frameURL(view);
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.style.cssText = 'position:absolute;left:-10000px;width:480px;height:360px;border:0;';
        const runner = connectTestFrame(frame, {origin: view.location.origin,
            context: () => ({savedGeneration: true, extensionURLs, testExtensionURL})});
        let abort: (() => void) | undefined;
        try {
            document.body.append(frame);
            const cancelled = new Promise<never>((_, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, {once: true});
                if (signal.aborted) abort();
            });
            return await Promise.race([runner.run({project: archive, signal}), cancelled]);
        } finally {
            if (abort) signal.removeEventListener('abort', abort);
            runner.dispose?.();
            frame.remove();
        }
    };

    const contextFor = (vm: TestEditorVM) => ({
        extensionURLs: Object.values(vm.extensionManager.getExtensionURLs?.() ?? {}),
        sandboxedExtensions: getExtensionIdentities(vm)
            .filter(extension => extension.execution === 'sandboxed')
            .map(({id, sha256}) => ({id, sha256}))
    });

    type TestProjectSnapshot = {archive: ArrayBuffer; extensionContext: ReturnType<typeof contextFor>};

    /** The way project search reveals a block: the sprite's code view, then the block at its center. */
    const showBlock = (vm: TestEditorVM, targetName: string, blockId: string) => {
        const target = vm.runtime.targets.find(candidate => candidate.isOriginal && candidate.getName() === targetName);
        if (!target) return;
        const navigation = ports.navigation(vm);
        if (!navigation || !navigation.activate(target.id)) vm.setEditingTarget(target.id);
        ports.document().defaultView!.requestAnimationFrame(() => navigation?.centerBlock(blockId));
    };

    const viewOptions = (vm: TestEditorVM, locale: string, doc: Document) => ({
        document: doc,
        locale,
        async getProject(): Promise<TestProjectSnapshot> {
            const extensionContext = contextFor(vm);
            const zip = vm._saveProjectZip();
            // Keep the archive's assets and Plus manifest, but use the editor's block IDs for failure navigation.
            zip.file('project.json', vm.toJSON(undefined, {allowOptimization: false}));
            const archive = await zip.generateAsync({type: 'arraybuffer'});
            return {archive, extensionContext};
        },
        // The view lists tests from project.json and passes the snapshot to the runner unchanged.
        listProject: () => vm.toJSON(undefined, {allowOptimization: false}),
        createRunner(stage: HTMLElement) {
            const frame = doc.createElement('iframe');
            frame.src = frameURL(ports.document().defaultView!);
            frame.title = testRunText(locale).stage;
            frame.style.cssText = 'width: 100%; height: 100%; border: 0; display: block;';
            stage.append(frame);
            const runner = connectTestFrame(frame, {
                origin: doc.defaultView!.location.origin,
                context: request => 'extensionContext' in request ? request.extensionContext : undefined
            });
            return {
                ...runner,
                run(request: Parameters<typeof runner.run>[0]) {
                    const {archive, extensionContext} = request.project as TestProjectSnapshot;
                    const frameRequest = {...request, project: archive, extensionContext};
                    return runner.run(frameRequest);
                }
            };
        },
        showBlock: (target: string, blockId: string) => showBlock(vm, target, blockId)
    });

    /** Opens the view as a workspace tab, or in a window of its own when the workspace takes no tabs. */
    const openTestRun = (vm: TestEditorVM, locale: string) => {
        const document = ports.document();
        const window = document.defaultView!;
        if (ports.openPanel(vm, testRunPanelRequest(viewOptions(vm, locale, document)))) return;
        const popup = window.open('', 'tw-plus-test-run', 'width=760,height=560');
        if (!popup) return;
        popup.document.title = testRunText(locale).title;
        popup.document.body.style.margin = '0';
        popup.document.body.replaceChildren();
        const view = createTestRunView(viewOptions(vm, locale, popup.document));
        popup.document.body.append(view.element);
        popup.addEventListener('pagehide', () => view.dispose(), {once: true});
        void view.refresh();
    };

    /** The run view menu's items (the workbench's `menuItems`). */
    const testRunMenuItems = (locale: string) => {
        const vm = editorVm;
        return vm ? [testRunMenuItem(locale, () => openTestRun(vm, locale))] : [];
    };

    /** Called when the editor's workspace attaches to its VM. */
    const connectTestRun = (vm: TestEditorVM) => {
        editorVm = vm;
        return {dispose() {
            if (editorVm === vm) editorVm = null;
        }};
    };

    return {runSavedGenerationTests, testRunMenuItems, connectTestRun};
}
