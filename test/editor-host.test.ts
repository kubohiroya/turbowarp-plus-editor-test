import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import Zip from '@turbowarp/jszip';
import {createTestRunEditor} from '../dist/editor-host.js';
const url = 'https://editor.test/sub/editor.html';
function fixture(popup?: JSDOM) {
    const dom = new JSDOM('', {url, pretendToBeVisual: true});
    if (popup) dom.window.open = () => popup.window as unknown as Window;
    let request;
    const activations: string[]=[];
    const controller=createTestRunEditor({document:()=>dom.window.document, zip:Zip,
        frameURL:view=>new URL('test-frame.html',view.location.href).href,
        identities:()=>[{id:'sample',sha256:'a'.repeat(64),execution:'sandboxed'},{id:'native',sha256:'c'.repeat(64),execution:'unsandboxed'}],
        openPanel:(_vm,panel)=>{request=panel; return !popup;},
        navigation:()=>({activate:target=>{activations.push(target); return true;},centerBlock:block=>{activations.push(block);}})});
    const project={targets:[],extensionURLs:{}};
    const serialized: string[]=[];
    const vm={runtime:{targets:[{id:'clone',isOriginal:false,getName:()=> 'Cat'},{id:'cat',isOriginal:true,getName:()=> 'Cat'}]},
        toJSON:(_target,options)=>{assert.equal(options.allowOptimization,false); return JSON.stringify(project);},
        _saveProjectZip:()=>({file(name,data){assert.equal(name,'project.json');serialized.push(data);},generateAsync:async()=>new ArrayBuffer(1)}),
        extensionManager:{getExtensionURLs:()=>({sample:'https://extensions.test/sample.js',legacy:'data:text/javascript,legacy'}),
            // The sample runs in a worker; the legacy URL was approved to run outside the sandbox.
            _loadedExtensions:new Map([['sample','extension.1.sample'],['legacy','unsandboxed.2.legacy'],['pen','pen']])},
        setEditingTarget:assert.fail};
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
    assert.deepEqual(sent.message.context,{extensionURLs:['https://extensions.test/sample.js','data:text/javascript,legacy'],
        unsandboxedExtensionURLs:['data:text/javascript,legacy'],
        sandboxedExtensions:[{id:'sample',sha256:'a'.repeat(64)}],unsandboxedExtensions:[{id:'native',sha256:'c'.repeat(64)}]});
    assert.equal(sent.message.project.byteLength,1);
    view.dispose();
    assert.equal(slot.querySelectorAll('iframe').length,0);active.dispose();
    assert.deepEqual(f.controller.testRunMenuItems('ja'),[]);
});
test('an about:blank popup keeps the Editor origin and rejects other senders', async t=>{
    const popup=new JSDOM('',{url:'about:blank',pretendToBeVisual:true});
    const f=fixture(popup);
    popup.window.name='tw-plus-test-run';
    Object.defineProperty(popup.window,'opener',{value:f.dom.window});
    t.after(()=>{
        popup.window.dispatchEvent(new popup.window.Event('pagehide'));
        popup.window.close();f.dom.window.close();
    });
    assert.equal(popup.window.location.origin,'null');
    const connection=f.controller.connectTestRun(f.vm);
    t.after(()=>connection.dispose());
    f.controller.testRunMenuItems('en')[0].onSelect();
    popup.window.document.querySelector('button')!.click();
    await new Promise(resolve=>setTimeout(resolve,10));
    const frame=popup.window.document.querySelector('iframe')!;
    assert.ok(frame);
    assert.equal(frame.src,'https://editor.test/sub/test-frame.html');
    const posted: any[]=[];
    frame.contentWindow!.postMessage=(message,origin)=>{posted.push({message,origin});};
    const ready=(source:any,origin:string)=>f.dom.window.dispatchEvent(new f.dom.window.MessageEvent('message',{
        source,origin,data:{type:'twpe-test:ready'}
    }));
    ready(frame.contentWindow!,'https://other.test');
    ready(popup.window,'https://editor.test');
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(posted.length,0);
    ready(frame.contentWindow!,'https://editor.test');
    await new Promise(resolve=>setTimeout(resolve,0));
    const sent=posted.find(entry=>entry.message.type==='twpe-test:run');
    assert.ok(sent,'the real frame handshake must start the run');
    assert.equal(sent.origin,'https://editor.test');
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
test('failed checks are marked on the blocks of the code shown, drawn again for new code, and cleared by the next run', async t=>{
    const dom=new JSDOM('<!doctype html><html><head></head><body></body></html>',{url,pretendToBeVisual:true});
    t.after(()=>dom.window.close());
    const doc=dom.window.document;
    const svgBlock=()=>{const root=doc.createElementNS('http://www.w3.org/2000/svg','g');doc.body.append(root);return root;};
    let blocks: Record<string, SVGElement>={check:svgBlock(),other:svgBlock()};
    let listener: (()=>void)|undefined;
    let request;
    const controller=createTestRunEditor({document:()=>doc,zip:Zip,
        frameURL:view=>new URL('test-frame.html',view.location.href).href,identities:()=>[],
        openPanel:(_vm,panel)=>{request=panel;return true;},
        navigation:()=>({activate:()=>true,centerBlock:()=>undefined,
            workspace:()=>({getBlockById:id=>blocks[id]?{getSvgRoot:()=>blocks[id]}:null})})});
    const vm={runtime:{targets:[{id:'cat',isOriginal:true,getName:()=> 'Cat'},{id:'stage',isOriginal:true,getName:()=> 'Stage'}]},
        editingTarget:{id:'cat'},
        on:(_event,fn)=>{listener=fn;},removeListener:(_event,fn)=>{if(listener===fn)listener=undefined;},
        toJSON:()=>JSON.stringify({targets:[]}),
        _saveProjectZip:()=>({file(){},generateAsync:async()=>new ArrayBuffer(1)}),
        extensionManager:{},setEditingTarget:assert.fail};
    const connection=controller.connectTestRun(vm as never);
    controller.testRunMenuItems('ja')[0].onSelect();
    const slot=doc.createElement('div');doc.body.append(slot);
    const view=request.mount(slot,()=>{});
    const runAll=slot.querySelector('button')!;
    const settle=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
    // Starts a run and returns a function that reports a result through the frame protocol.
    const startRun=async()=>{
        runAll.click();
        await settle(10);
        const frame=slot.querySelector('iframe')!;
        const posted: any[]=[];
        frame.contentWindow!.postMessage=message=>{posted.push(message);};
        const fromFrame=(data:unknown)=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:frame.contentWindow!,origin:'https://editor.test',data}));
        fromFrame({type:'twpe-test:ready'});
        await settle();
        const id=posted.find(message=>message.type==='twpe-test:run').id;
        return {end:(result:unknown)=>fromFrame({type:'twpe-test:end',id,result}),
            done:()=>fromFrame({type:'twpe-test:done',id,report:{results:[]}})};
    };
    const failed=(target:string,blockId:string)=>({address:`${target}/t`,target,blockId:'t',name:'t',status:'failed',frames:1,durationMs:1,
        assertions:[{kind:'strict-equals',passed:false,blockId,topBlockId:'t',targetId:'x',frame:1,expected:3,actual:2},
            {kind:'true',passed:true,blockId:'other',topBlockId:'t',targetId:'x',frame:1}]});
    const badge=(root:SVGElement)=>root.querySelector('.twpe-test-failure__badge');

    const first=await startRun();
    first.end(failed('Cat','check'));
    first.end(failed('Stage','other'));
    await settle();
    assert.ok(blocks.check.classList.contains('twpe-test-failure'));
    assert.equal(badge(blocks.check)!.querySelector('title')!.textContent,'=== で等しくない / 期待: 3 / 実際: 2');
    // A passed check is not marked, and the stage's failure waits until the stage's code is shown.
    assert.equal(blocks.other.classList.contains('twpe-test-failure'),false);
    assert.ok(doc.getElementById('twpe-test-failure-styles'));
    first.done();
    await settle();

    // Showing the stage draws its blocks, which Blockly creates anew.
    const previous=blocks.check;
    blocks={check:svgBlock(),other:svgBlock()};
    vm.editingTarget={id:'stage'};
    assert.ok(listener,'the marks follow the code the editor shows');
    listener!();
    await settle(50);
    assert.equal(previous.classList.contains('twpe-test-failure'),false);
    assert.equal(badge(previous),null);
    assert.ok(blocks.other.classList.contains('twpe-test-failure'));
    assert.equal(blocks.check.classList.contains('twpe-test-failure'),false);

    // A new run starts over the old results. The frame is ready already, so the run goes out at once.
    runAll.click();
    await settle(10);
    assert.equal(blocks.other.classList.contains('twpe-test-failure'),false);
    assert.equal(badge(blocks.other),null);
    assert.equal(listener,undefined);
    view.dispose();
    connection.dispose();
});
test('closing the view clears the marks it drew', async t=>{
    const dom=new JSDOM('<!doctype html><html><head></head><body></body></html>',{url,pretendToBeVisual:true});
    t.after(()=>dom.window.close());
    const doc=dom.window.document;
    const root=doc.createElementNS('http://www.w3.org/2000/svg','g');doc.body.append(root);
    let request;
    const controller=createTestRunEditor({document:()=>doc,zip:Zip,frameURL:view=>new URL('test-frame.html',view.location.href).href,
        identities:()=>[],openPanel:(_vm,panel)=>{request=panel;return true;},
        navigation:()=>({activate:()=>true,centerBlock:()=>undefined,workspace:()=>({getBlockById:()=>({getSvgRoot:()=>root})})})});
    const vm={runtime:{targets:[{id:'cat',isOriginal:true,getName:()=> 'Cat'}]},editingTarget:{id:'cat'},on(){},removeListener(){},
        toJSON:()=>JSON.stringify({targets:[]}),_saveProjectZip:()=>({file(){},generateAsync:async()=>new ArrayBuffer(1)}),
        extensionManager:{},setEditingTarget:assert.fail};
    const connection=controller.connectTestRun(vm as never);
    controller.testRunMenuItems('en')[0].onSelect();
    const slot=doc.createElement('div');doc.body.append(slot);
    const view=request.mount(slot,()=>{});
    slot.querySelector('button')!.click();
    await new Promise(resolve=>setTimeout(resolve,10));
    const frame=slot.querySelector('iframe')!;
    const posted: any[]=[];
    frame.contentWindow!.postMessage=message=>{posted.push(message);};
    const fromFrame=(data:unknown)=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:frame.contentWindow!,origin:'https://editor.test',data}));
    fromFrame({type:'twpe-test:ready'});
    await new Promise(resolve=>setTimeout(resolve,0));
    const id=posted.find(message=>message.type==='twpe-test:run').id;
    fromFrame({type:'twpe-test:end',id,result:{address:'Cat/t',target:'Cat',blockId:'t',name:'t',status:'failed',frames:1,durationMs:1,
        assertions:[{kind:'true',passed:false,blockId:'check',topBlockId:'t',targetId:'x',frame:1}]}});
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.ok(root.classList.contains('twpe-test-failure'));
    view.dispose();
    assert.equal(root.classList.contains('twpe-test-failure'),false);
    assert.equal(root.querySelector('.twpe-test-failure__badge'),null);
    connection.dispose();
});
