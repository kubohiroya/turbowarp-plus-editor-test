import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import Zip from '@turbowarp/jszip';
import {createTestRunEditor} from '../dist/editor-host.js';
const url = 'https://editor.test/sub/editor.html';
function fixture() {
    const dom = new JSDOM('', {url, pretendToBeVisual: true});
    let request;
    const activations: string[]=[];
    const controller=createTestRunEditor({document:()=>dom.window.document, zip:Zip,
        frameURL:view=>new URL('test-frame.html',view.location.href).href,
        identities:()=>[{id:'sample',sha256:'a'.repeat(64),execution:'sandboxed'}],
        openPanel:(_vm,panel)=>{request=panel; return true;},
        navigation:()=>({activate:target=>{activations.push(target); return true;},centerBlock:block=>{activations.push(block);}})});
    const project={targets:[],extensionURLs:{}};
    const serialized: string[]=[];
    const vm={runtime:{targets:[{id:'clone',isOriginal:false,getName:()=> 'Cat'},{id:'cat',isOriginal:true,getName:()=> 'Cat'}]},
        toJSON:(_target,options)=>{assert.equal(options.allowOptimization,false); return JSON.stringify(project);},
        _saveProjectZip:()=>({file(name,data){assert.equal(name,'project.json');serialized.push(data);},generateAsync:async()=>new ArrayBuffer(1)}),
        extensionManager:{getExtensionURLs:()=>({sample:'https://extensions.test/sample.js'})},setEditingTarget:assert.fail};
    return {dom,vm,controller,serialized,activations,panel:()=>request};
}
test('connection disposal cannot disconnect a newer VM; the panel snapshot keeps raw IDs and committed identities', async t=>{
    const f=fixture();t.after(()=>f.dom.window.close());
    const old=f.controller.connectTestRun({...f.vm});
    const active=f.controller.connectTestRun(f.vm);old.dispose();
    f.controller.testRunMenuItems('ja')[0].onSelect();
    const panel=f.panel();
    // The Workbench receives a lazy panel factory, so its document remains authoritative.
    const slot=f.dom.window.document.createElement('div');
    f.dom.window.document.body.append(slot);
    const view=panel.mount(slot,()=>{});
    slot.querySelector('button')!.click();
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(f.serialized.length,1);
    assert.equal(slot.querySelectorAll('iframe').length,1);
    const frame=slot.querySelector('iframe')!;
    const posted: any[]=[];
    frame.contentWindow!.postMessage=(message, origin)=>{posted.push({message,origin});};
    f.dom.window.dispatchEvent(new f.dom.window.MessageEvent('message',{source:frame.contentWindow!,
        origin:'https://editor.test',data:{type:'twpe-test:ready'}}));
    await new Promise(resolve=>setTimeout(resolve,0));
    const sent=posted.find(entry=>entry.message.type==='twpe-test:run');
    assert.equal(sent.origin,'https://editor.test');
    assert.deepEqual(sent.message.context,{extensionURLs:['https://extensions.test/sample.js'],
        sandboxedExtensions:[{id:'sample',sha256:'a'.repeat(64)}]});
    assert.equal(sent.message.project.byteLength,1);
    view.dispose();
    assert.equal(slot.querySelectorAll('iframe').length,0);active.dispose();
    assert.deepEqual(f.controller.testRunMenuItems('ja'),[]);
});
test('aborting a saved-generation run removes its hidden iframe and message listener', async t=>{
    const f=fixture();t.after(()=>f.dom.window.close());
    const zip=new Zip();zip.file('project.json',JSON.stringify({targets:[],extensionURLs:{}}));
    const archive=await zip.generateAsync({type:'arraybuffer'});
    const abort=new AbortController();
    const running=f.controller.runSavedGenerationTests(f.dom.window.document,archive,abort.signal);
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(f.dom.window.document.querySelectorAll('iframe').length,1);
    abort.abort(new Error('cancelled'));
    await assert.rejects(running,/cancelled/);
    assert.equal(f.dom.window.document.querySelectorAll('iframe').length,0);
});
test('a cancellation during archive decoding never creates a frame', async t=>{
    const f=fixture();t.after(()=>f.dom.window.close());
    const abort=new AbortController();abort.abort();
    const zip=new Zip();zip.file('project.json','{}');
    await assert.rejects(f.controller.runSavedGenerationTests(f.dom.window.document,await zip.generateAsync({type:'arraybuffer'}),abort.signal),{name:'AbortError'});
    assert.equal(f.dom.window.document.querySelectorAll('iframe').length,0);
});
