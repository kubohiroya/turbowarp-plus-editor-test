// SPDX-License-Identifier: MPL-2.0
import {TEST_EXTENSION_ID} from './protocol.ts';
import {serveTestFrame, type TestFrameServerOptions} from './test-frame.ts';

export interface TestFrameCode {
    id: string; execution: string; source: {type: string}; sha256: string; actualSHA256: string;
}
export interface TestFrameCatalog {
    isTrustedCode(code: TestFrameCode): Promise<boolean>;
    isTrustedURLDigest(url: string, digest: string): Promise<boolean>;
}
export interface TestFramePolicyOptions {
    catalogURL: string;
    catalog: TestFrameCatalog;
    fetch?: typeof fetch;
    urls?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
}
export interface TestSecurityManager {
    canLoadExtensionFromProject(url: string): Promise<boolean>;
    getSandboxMode(url: string): Promise<string>;
    rewriteExtensionURL(url: string): Promise<string>;
}

export function createTestFramePolicy(options: TestFramePolicyOptions) {
    const urls = options.urls ?? URL;
    let context: {extensionURLs: string[]; sandboxedExtensions: {id: string; sha256: string}[]; savedGeneration: boolean} = {
        extensionURLs: [], sandboxedExtensions: [], savedGeneration: false
    };
    let disposed = false;
    let generation = 0;
    let legacyTest: {url: string; verifiedUrl: string} | undefined;
    const isEmbedded = (code: TestFrameCode) => code.execution === 'sandboxed' &&
        ['embedded-file', 'embedded-data'].includes(code.source.type) && code.sha256 === code.actualSHA256;
    const isApproved = (code: TestFrameCode) => isEmbedded(code) && context.sandboxedExtensions.some(entry =>
        entry.id === code.id && entry.sha256 === code.actualSHA256);
    const releaseLegacy = () => {
        if (legacyTest) urls.revokeObjectURL(legacyTest.verifiedUrl);
        legacyTest = undefined;
    };
    return {
        dispose() {disposed = true; generation++; releaseLegacy();},
        async canLoadCode(code: TestFrameCode) {
            if (!context.savedGeneration) return isApproved(code) || await options.catalog.isTrustedCode(code);
            if (code.id === TEST_EXTENSION_ID) return code.execution === 'unsandboxed' &&
                await options.catalog.isTrustedURLDigest(options.catalogURL, code.actualSHA256);
            return isEmbedded(code);
        },
        async requestApproval(code: TestFrameCode) {
            return context.savedGeneration ? isEmbedded(code) : isApproved(code);
        },
        configureSecurityManager(manager: TestSecurityManager) {
            manager.canLoadExtensionFromProject = async url => context.extensionURLs.includes(url);
            manager.getSandboxMode = async url => legacyTest?.url === url ? 'unsandboxed' : 'iframe';
            const rewrite = manager.rewriteExtensionURL.bind(manager);
            manager.rewriteExtensionURL = url => legacyTest?.url === url ? Promise.resolve(legacyTest.verifiedUrl) : rewrite(url);
        },
        async prepare(input: unknown) {
            if (disposed) throw new Error('Test frame disposed');
            const preparing = ++generation;
            releaseLegacy();
            const data = input as {extensionURLs?: unknown; sandboxedExtensions?: unknown; savedGeneration?: unknown; testExtensionURL?: unknown} | undefined;
            context = {
                extensionURLs: Array.isArray(data?.extensionURLs) ? data.extensionURLs.filter((url): url is string => typeof url === 'string') : [],
                savedGeneration: data?.savedGeneration === true,
                sandboxedExtensions: Array.isArray(data?.sandboxedExtensions) ? data.sandboxedExtensions.filter(
                    (entry): entry is {id: string; sha256: string} => typeof entry?.id === 'string' &&
                        typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)) : []
            };
            const source = data?.testExtensionURL;
            if (!context.savedGeneration || source === undefined) return;
            if (typeof source !== 'string' || (source !== options.catalogURL && !source.startsWith('data:')))
                throw new Error('The saved test extension does not match the trusted catalog.');
            const response = await (options.fetch ?? fetch)(source, {signal: AbortSignal.timeout(15000), credentials: 'omit'});
            if (!response.ok) throw new Error('Could not load the test extension.');
            const bytes = await response.arrayBuffer();
            const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                byte => byte.toString(16).padStart(2, '0')).join('');
            if (!await options.catalog.isTrustedURLDigest(options.catalogURL, digest))
                throw new Error('The saved test extension does not match the trusted catalog.');
            if (disposed || preparing !== generation) throw new Error('Test frame preparation cancelled');
            legacyTest = {url: source, verifiedUrl: urls.createObjectURL(new Blob([bytes], {type: 'text/javascript'}))};
        }
    };
}

export function startTestFrame(options: TestFramePolicyOptions & {
    window: Window;
    createVM(canvas: HTMLCanvasElement, policy: ReturnType<typeof createTestFramePolicy>): ReturnType<TestFrameServerOptions['getVm']>;
    identities(vm: Parameters<NonNullable<TestFrameServerOptions['getLoadedBuilds']>>[0]): readonly {id: string; sha256: string; execution: string}[];
}) {
    const policy = createTestFramePolicy(options);
    const {window} = options;
    const document = window.document;
    let canvas: HTMLCanvasElement | undefined;
    const stop = serveTestFrame({window, origin: window.location.origin, prepare: policy.prepare,
        getLoadedBuilds: vm => options.identities(vm).filter(({execution}) => execution === 'sandboxed')
            .map(({id, sha256}) => ({extensionId: id, sha256})),
        getVm() {
            document.documentElement.style.cssText = 'height: 100%;';
            document.body.style.cssText = 'margin: 0; height: 100%; overflow: hidden;';
            canvas = document.createElement('canvas');
            canvas.style.cssText = 'width: 100%; height: 100%; display: block;';
            document.body.append(canvas);
            return options.createVM(canvas, policy);
        }
    });
    const dispose = () => {stop(); policy.dispose(); canvas?.remove(); window.removeEventListener('pagehide', dispose);};
    window.addEventListener('pagehide', dispose, {once: true});
    return dispose;
}
