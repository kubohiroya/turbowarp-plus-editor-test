import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestFramePolicy} from '../dist/frame-host.js';
import {TEST_EXTENSION_ID} from '../dist/protocol.js';
const digest = 'a'.repeat(64);
const catalogURL = 'https://catalog.test/test.js';
const code = (changes = {}) => ({id: 'sample', execution: 'sandboxed', source: {type: 'embedded-file'}, sha256: digest, actualSHA256: digest, ...changes});
const catalog = {isTrustedCode: async () => false, isTrustedURLDigest: async () => false};

test('live runs approve only the exact committed sandboxed identity, never a digest from another extension', async () => {
    const policy = createTestFramePolicy({catalogURL, catalog});
    await policy.prepare({sandboxedExtensions: [{id: 'sample', sha256: digest}, {id: 'bad', sha256: 'bad'}]});
    assert.equal(await policy.canLoadCode(code()), true);
    assert.equal(await policy.canLoadCode(code({id: 'other'})), false);
    assert.equal(await policy.requestApproval(code({actualSHA256: 'b'.repeat(64)})), false);
    assert.equal(await policy.canLoadCode(code({execution: 'unsandboxed'})), false);
    await policy.prepare(undefined);
    assert.equal(await policy.canLoadCode(code()), false);
});

test('saved runs permit only embedded sandboxed code and the catalog-verified unsandboxed test runner', async () => {
    const policy = createTestFramePolicy({catalogURL, catalog: {isTrustedCode: async () => true,
        isTrustedURLDigest: async (url, value) => url === catalogURL && value === digest}});
    await policy.prepare({savedGeneration: true});
    assert.equal(await policy.canLoadCode(code()), true);
    assert.equal(await policy.canLoadCode(code({execution: 'unsandboxed'})), false);
    assert.equal(await policy.canLoadCode(code({source: {type: 'remote-cacheable'}})), false);
    assert.equal(await policy.canLoadCode(code({id: TEST_EXTENSION_ID, execution: 'unsandboxed'})), true);
    assert.equal(await policy.canLoadCode(code({id: TEST_EXTENSION_ID, execution: 'sandboxed'})), false);
});

test('legacy test bytes are verified before URL rewriting; each new run and disposal revoke the Blob', async () => {
    const revoked: string[] = [];
    const bytes = new TextEncoder().encode('verified runner');
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    let reads = 0;
    const policy = createTestFramePolicy({catalogURL, catalog: {...catalog,
        isTrustedURLDigest: async (url, value) => url === catalogURL && value === sha},
        fetch: async () => {reads++; return new Response(bytes);},
        urls: {createObjectURL: () => 'blob:verified', revokeObjectURL: url => {revoked.push(url);}}});
    const manager = {canLoadExtensionFromProject: async () => false, getSandboxMode: async () => 'iframe', rewriteExtensionURL: async url => url};
    policy.configureSecurityManager(manager);
    await assert.rejects(policy.prepare({savedGeneration: true, testExtensionURL: 'https://evil.test/test.js'}));
    assert.equal(reads, 0);
    await policy.prepare({savedGeneration: true, extensionURLs: [catalogURL, 42], testExtensionURL: catalogURL});
    assert.equal(await manager.getSandboxMode(catalogURL), 'unsandboxed');
    assert.equal(await manager.rewriteExtensionURL(catalogURL), 'blob:verified');
    assert.equal(await manager.canLoadExtensionFromProject(catalogURL), true);
    await policy.prepare({savedGeneration: false});
    assert.deepEqual(revoked, ['blob:verified']);
    assert.equal(await manager.getSandboxMode(catalogURL), 'iframe');
    assert.equal(await manager.rewriteExtensionURL(catalogURL), catalogURL);
    await policy.prepare({savedGeneration: true, testExtensionURL: catalogURL});
    policy.dispose();
    assert.deepEqual(revoked, ['blob:verified', 'blob:verified']);
});

test('a digest mismatch never creates a legacy execution URL', async () => {
    const policy = createTestFramePolicy({catalogURL, catalog, fetch: async () => new Response('untrusted'),
        urls: {createObjectURL: assert.fail, revokeObjectURL: assert.fail}});
    await assert.rejects(policy.prepare({savedGeneration: true, testExtensionURL: 'data:text/javascript,untrusted'}), /trusted catalog/);
});

test('disposal during verification cannot leave a late executable Blob URL', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => {finish=resolve;});
    const policy=createTestFramePolicy({catalogURL,catalog:{...catalog,isTrustedURLDigest:async()=>true},
        fetch:async()=>pending,urls:{createObjectURL:assert.fail,revokeObjectURL:assert.fail}});
    const preparing=policy.prepare({savedGeneration:true,testExtensionURL:catalogURL});
    policy.dispose();finish(new Response('code'));
    await assert.rejects(preparing,/cancelled/);
});

test('a live run takes outside the sandbox only the URLs and digests the Editor ran there', async () => {
    const legacy = 'data:text/javascript;base64,YXBwcm92ZWQ=';
    const gallery = 'https://extensions.test/approved.js';
    const policy = createTestFramePolicy({catalogURL, catalog});
    const manager = {canLoadExtensionFromProject: async () => false, getSandboxMode: async () => 'iframe', rewriteExtensionURL: async url => url};
    policy.configureSecurityManager(manager);
    await policy.prepare({extensionURLs: [legacy, gallery, 'data:text/javascript,sandboxed'],
        unsandboxedExtensionURLs: [legacy, gallery, 'https://not-in-the-project.test/x.js'],
        unsandboxedExtensions: [{id: 'sample', sha256: digest}]});
    assert.equal(await manager.getSandboxMode(legacy), 'unsandboxed');
    assert.equal(await manager.getSandboxMode(gallery), 'unsandboxed');
    assert.equal(await manager.getSandboxMode('data:text/javascript,sandboxed'), 'iframe');
    // A URL the project does not name is not loaded at all, so it cannot be approved either.
    assert.equal(await manager.getSandboxMode('https://not-in-the-project.test/x.js'), 'iframe');
    assert.equal(await policy.canLoadCode(code({execution: 'unsandboxed'})), true);
    assert.equal(await policy.requestApproval(code({execution: 'unsandboxed'})), true);
    // Only the exact digest the Editor committed, and only for the same extension.
    assert.equal(await policy.canLoadCode(code({execution: 'unsandboxed', actualSHA256: 'b'.repeat(64)})), false);
    assert.equal(await policy.canLoadCode(code({execution: 'unsandboxed', id: 'other'})), false);
    // The approval to run outside the sandbox does not let the same code in sandboxed under another approval.
    assert.equal(await policy.canLoadCode(code()), false);
    // The next run starts from what that run sends.
    await policy.prepare({extensionURLs: [legacy]});
    assert.equal(await manager.getSandboxMode(legacy), 'iframe');
    assert.equal(await policy.canLoadCode(code({execution: 'unsandboxed'})), false);
});

test('a saved generation carries no approval to run outside the sandbox', async () => {
    const legacy = 'data:text/javascript;base64,YXBwcm92ZWQ=';
    const policy = createTestFramePolicy({catalogURL, catalog});
    const manager = {canLoadExtensionFromProject: async () => false, getSandboxMode: async () => 'iframe', rewriteExtensionURL: async url => url};
    policy.configureSecurityManager(manager);
    await policy.prepare({savedGeneration: true, extensionURLs: [legacy], unsandboxedExtensionURLs: [legacy],
        unsandboxedExtensions: [{id: 'sample', sha256: digest}]});
    assert.equal(await manager.getSandboxMode(legacy), 'iframe');
    assert.equal(await policy.canLoadCode(code({execution: 'unsandboxed'})), false);
});
