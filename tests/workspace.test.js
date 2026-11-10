const test=require('node:test'); const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const workspace=require('../backend/workspace');const {Store}=require('../backend/store');
async function fixture(){return fs.mkdtemp(path.join(os.tmpdir(),'nano-test-'));}

test('project boundary rejects traversal, private data and dangling symbolic links',async(t)=>{
 const root=await fixture();await fs.writeFile(path.join(root,'file.txt'),'safe');
 assert.equal((await workspace.readFile(root,'file.txt')).content,'safe');
 await assert.rejects(workspace.writeFile(root,'../outside.txt','x'),/项目范围/);
 await assert.rejects(workspace.writeFile(root,'.nano/settings.json','x'),/数据目录/);
 const link=path.join(root,'dangling');
 try {await fs.symlink(path.join(root,'..','nano-outside-nonexistent.txt'),link,'file');}
 catch(error){if(error.code==='EPERM'){t.diagnostic('Windows user lacks symlink permission; dangling-link assertion skipped');return;}throw error;}
 await assert.rejects(workspace.writeFile(root,'dangling','unsafe'),/符号链接/);
});

test('store serializes concurrent updates without losing tasks and encrypts saved keys',async()=>{
 const root=await fixture();const encryption={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('sealed:'+value),decryptString:buffer=>buffer.toString().slice(7)};
 const store=new Store(root,encryption);
 await Promise.all(Array.from({length:12},(_,i)=>store.saveTask({id:String(i),messages:[]})));
 assert.equal((await store.tasks()).length,12);
 await store.saveSettings({provider:'openai',apiKey:'test-private-key',model:'mock'});
 assert.equal((await store.settings()).apiKey,undefined);assert.equal((await store.settings()).hasApiKey,true);
 assert.equal((await store.privateSettings()).apiKey,'test-private-key');
 const raw=await fs.readFile(path.join(root,'settings.json'),'utf8');assert.equal(raw.includes('test-private-key'),false);
 await store.saveSettings({model:'other',apiKey:''});assert.equal((await store.privateSettings()).apiKey,'test-private-key');
 await store.saveSettings({clearApiKey:true});assert.equal((await store.settings()).hasApiKey,false);
});

test('a missing encryption service never silently stores plaintext credentials',async()=>{
 const store=new Store(await fixture(),{isEncryptionAvailable:()=>false});
 await assert.rejects(store.saveSettings({apiKey:'secret'}),/加密不可用/);
 assert.equal((await store.settings()).hasApiKey,false);
});

test('concurrent setting changes merge and MCP secrets remain encrypted and private',async()=>{
 const root=await fixture();const encryption={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('sealed:'+value),decryptString:buffer=>buffer.toString().slice(7)};
 const store=new Store(root,encryption);
 await Promise.all([store.saveSettings({theme:'light'}),store.saveSettings({model:'new-model'})]);
 assert.equal((await store.settings()).theme,'light');assert.equal((await store.settings()).model,'new-model');
 await store.saveSettings({mcpServers:[{id:'server',name:'S',type:'stdio',command:'node',env:{TOKEN:'never-in-plaintext'}}]});
 const publicServer=(await store.settings()).mcpServers[0];assert.equal(publicServer.env,undefined);assert.equal(publicServer.encryptedEnv,undefined);assert.equal(publicServer.hasEnv,true);
 assert.equal((await store.privateSettings()).mcpServers[0].env.TOKEN,'never-in-plaintext');
 assert.equal((await fs.readFile(path.join(root,'settings.json'),'utf8')).includes('never-in-plaintext'),false);
 await store.saveSettings({mcpServers:[{...publicServer,name:'Renamed'}]});assert.equal((await store.privateSettings()).mcpServers[0].env.TOKEN,'never-in-plaintext');
});
