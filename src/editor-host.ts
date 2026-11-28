// SPDX-License-Identifier: MPL-2.0
// Original Plus Editor test launcher, provided by its rights holder under MPL-2.0.
import {connectTestFrame} from './test-frame.ts';
import {TEST_EXTENSION_ID} from './protocol.ts';
import {createTestRunView, testRunMenuItem, testRunPanelRequest, testRunText, type FailureMark} from './test-run-view.ts';

export type TestEditorVM = {
    runtime: {targets: Array<{id: string; isOriginal: boolean; getName(): string}>};
    toJSON(targetId?: string, options?: {allowOptimization?: boolean}): string;
    _saveProjectZip(): {file(name: string, data: string): unknown; generateAsync(options: {type: 'arraybuffer'}): Promise<ArrayBuffer>};
    extensionManager: {getExtensionURLs?(): Record<string, string>};
    setEditingTarget(targetId: string): void;
    /** The sprite or stage whose code the editor shows. Failure marks are drawn on its blocks. */
    editingTarget?: {id: string} | null;
    on?(event: 'workspaceUpdate', listener: () => void): void;
    removeListener?(event: 'workspaceUpdate', listener: () => void): void;
};

/** The part of the editor's Blockly workspace that failure marks use. */
export interface TestEditorWorkspace {
    getBlockById(id: string): {getSvgRoot(): SVGElement | null} | null;
}

export interface TestEditorNavigation {
    activate(targetId: string): boolean;
    centerBlock(blockId: string): void;
    /** The workspace of the code being shown, if it is visible. Without it failures are not marked on blocks. */
    workspace?(): TestEditorWorkspace | undefined;
}

export interface TestEditorPorts {
    document(): Document;
    frameURL(view: Window): string;
    zip: {loadAsync(archive: ArrayBuffer): Promise<{file(name: string): {async(type: 'string'): Promise<string>} | null}>};
    identities(vm: TestEditorVM): readonly {id: string; sha256: string; execution: string}[];
    openPanel(vm: TestEditorVM, request: ReturnType<typeof testRunPanelRequest>): boolean;
    navigation(vm: TestEditorVM): TestEditorNavigation | undefined;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARK_CLASS = 'twpe-test-failure';
const markStyles = `
.${MARK_CLASS} > .blocklyPath { stroke: #dc2626 !important; stroke-width: 3px !important; }
.${MARK_CLASS}__badge circle { fill: #dc2626; stroke: #fff; stroke-width: 2px; }
.${MARK_CLASS}__badge text { fill: #fff; font: bold 13px sans-serif; text-anchor: middle; dominant-baseline: central; pointer-events: none; }
`;

/**
 * Draws the failed checks on the editor's blocks: a red outline and a badge whose tooltip says why. Only the blocks of
 * the code being shown can be drawn, so the marks are drawn again whenever the editor shows other code, until the
 * next set replaces them.
 */
function createFailureMarks(vm: TestEditorVM, ports: TestEditorPorts) {
    let marks: Array<FailureMark & {targetId: string}> = [];
    let drawn: Array<{root: SVGElement; badge: SVGElement}> = [];
    let listening = false;
    let frame: number | undefined;

    const erase = () => {
        for (const {root, badge} of drawn) {
            root.classList.remove(MARK_CLASS);
            badge.remove();
        }
        drawn = [];
    };

    const draw = () => {
        erase();
        const editing = vm.editingTarget?.id;
        const workspace = ports.navigation(vm)?.workspace?.();
        if (!workspace || !editing) return;
        for (const mark of marks) {
            if (mark.targetId !== editing) continue;
            const root = workspace.getBlockById(mark.blockId)?.getSvgRoot();
            if (!root) continue;
            const doc = root.ownerDocument;
            if (!doc.getElementById(`${MARK_CLASS}-styles`)) {
                const style = doc.createElement('style');
                style.id = `${MARK_CLASS}-styles`;
                style.textContent = markStyles;
                doc.head.append(style);
            }
            const badge = doc.createElementNS(SVG_NS, 'g');
            badge.setAttribute('class', `${MARK_CLASS}__badge`);
            badge.setAttribute('transform', 'translate(-6, -6)');
            const title = doc.createElementNS(SVG_NS, 'title');
            title.textContent = mark.label;
            const circle = doc.createElementNS(SVG_NS, 'circle');
            circle.setAttribute('r', '9');
            const sign = doc.createElementNS(SVG_NS, 'text');
            sign.textContent = '!';
            badge.append(title, circle, sign);
            root.classList.add(MARK_CLASS);
            root.append(badge);
            drawn.push({root, badge});
        }
    };

    /** Blockly fills the workspace after the VM announces new code, so draw on the next frame. */
    const redraw = () => {
        const view = ports.document().defaultView;
        if (!view) return draw();
        if (frame !== undefined) view.cancelAnimationFrame(frame);
        frame = view.requestAnimationFrame(() => {
            frame = undefined;
            draw();
        });
    };

    const listen = (on: boolean) => {
        if (on === listening) return;
        listening = on;
        if (on) vm.on?.('workspaceUpdate', redraw);
        else vm.removeListener?.('workspaceUpdate', redraw);
    };

    return {
        set(next: readonly FailureMark[]) {
            marks = next.flatMap(mark => {
                const target = vm.runtime.targets.find(candidate => candidate.isOriginal && candidate.getName() === mark.target);
                return target ? [{...mark, targetId: target.id}] : [];
            });
            listen(marks.length > 0);
            draw();
        },
        redraw,
        dispose() {
            if (frame !== undefined) ports.document().defaultView?.cancelAnimationFrame(frame);
            frame = undefined;
            marks = [];
            listen(false);
            erase();
        }
    };
}

export function createTestRunEditor(ports: TestEditorPorts) {
    const {frameURL, zip: JSZip, identities: getExtensionIdentities} = ports;
    let editorVm: TestEditorVM | null = null;
    let failureMarks: {vm: TestEditorVM; marks: ReturnType<typeof createFailureMarks>} | null = null;
    const marksFor = (vm: TestEditorVM) => {
        if (failureMarks?.vm !== vm) {
            failureMarks?.marks.dispose();
            failureMarks = {vm, marks: createFailureMarks(vm, ports)};
        }
        return failureMarks.marks;
    };

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
        ports.document().defaultView!.requestAnimationFrame(() => {
            navigation?.centerBlock(blockId);
            marksFor(vm).redraw();
        });
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
                // The popup's about:blank URL has a null origin; the Editor owns the frame protocol.
                origin: ports.document().defaultView!.location.origin,
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
        showBlock: (target: string, blockId: string) => showBlock(vm, target, blockId),
        markFailures: (marks: readonly FailureMark[]) => marksFor(vm).set(marks)
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
            if (failureMarks?.vm === vm) {
                failureMarks.marks.dispose();
                failureMarks = null;
            }
        }};
    };

    return {runSavedGenerationTests, testRunMenuItems, connectTestRun};
}
