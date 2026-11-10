'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerSideAgent } = require('../backend/side-agent');
const { AgentRuntime } = require('../backend/agent');
const { BaseChatModel } = require('@langchain/core/language_models/chat_models');
const { AIMessageChunk } = require('@langchain/core/messages');
const { ChatGenerationChunk } = require('@langchain/core/outputs');
function setup(factory) {
  const handlers = {}, emitted = [], sender = { isDestroyed: () => false, send: (_channel, data) => emitted.push(data) };
  const window = { webContents: sender, isDestroyed: () => false };
  registerSideAgent({ ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, getWindow: () => window,
    getTask: async () => ({ id: 'main', projectPath: 'E:/Nano', history: [{ role: 'user', content: '主会话已有问题' }, { role: 'assistant', content: '主会话已有答案' }] }),
    getConfig: async () => ({ provider: 'openai', permissionMode: 'ask' }), getTools: () => [{ name: 'read_file' }],
    executeTool: async () => ({ ok: true }), getSystemPrompt: async () => '默认规则', runtimeFactory: factory });
  return { handlers, emitted, event: { sender } };
}
test('side runtime inherits main history, routes side events and returns only side history', async () => {
  let captured;
  const { handlers, emitted, event } = setup(() => ({ run: async (payload, emit) => { captured=payload;emit({ type:'message.delta', runId:payload.runId, taskId:payload.taskId, content:'完成' });return { ok:true,status:'success',history:[...payload.messages,{role:'assistant',content:'完成'}] }; } }));
  const result=await handlers['side:agent-run'](event,{runId:'side-1',taskId:'main',text:'侧边任务',history:[{role:'user',content:'旧侧聊'}]});
  assert.equal(captured.messages[0].content,'主会话已有问题');assert.equal(captured.messages.at(-2).content,'旧侧聊');assert.equal(captured.messages.at(-1).content,'侧边任务');
  assert.equal(result.history.length,3);assert.equal(result.history[0].content,'旧侧聊');assert.equal(result.history[1].content,'侧边任务');assert.equal(emitted[0].runId,'side-1');
});
test('side approval and cancellation target only their run', async () => {
  let finish, cancelled=false, approval;
  const { handlers, event }=setup(()=>({run:()=>new Promise(resolve=>{finish=resolve;}),cancel:()=>{cancelled=true;finish({ok:false,status:'cancelled',history:[]});return true;},approve:decision=>{approval=decision;return true;},setPermission:()=>true}));
  const running=handlers['side:agent-run'](event,{runId:'side-2',taskId:'main',text:'x'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(handlers['side:agent-cancel'](event,'other'),false);
  assert.equal(handlers['side:agent-approve'](event,{runId:'side-2',approvalId:'a',approved:true}),true);assert.equal(approval.approvalId,'a');
  assert.equal(handlers['side:agent-cancel'](event,'side-2'),true);assert.equal(cancelled,true);assert.equal((await running).status,'cancelled');
});
test('real LangChain side agent waits for approval, executes tool and streams answer', async () => {
  class FakeModel extends BaseChatModel {
    constructor() { super({});this.calls=0; }
    _llmType() { return 'fake-side'; } bindTools() { return this; }
    async *_streamResponseChunks(_messages,_options,runManager) {
      this.calls++;
      const message=this.calls===1?new AIMessageChunk({content:'',tool_calls:[{name:'write_file',args:{path:'a',content:'b'},id:'call-side',type:'tool_call'}]}):new AIMessageChunk({content:'侧聊完成'});
      if(message.content)await runManager?.handleLLMNewToken(message.content,{},undefined,'text');
      yield new ChatGenerationChunk({message,text:String(message.content || '')});
    }
    async _generate(messages,options,runManager) { const chunks=[];for await(const chunk of this._streamResponseChunks(messages,options,runManager))chunks.push(chunk);return {generations:[{message:chunks[0].message,text:chunks[0].text}]}; }
  }
  const handlers={}, emitted=[], sender={isDestroyed:()=>false,send:(_channel,data)=>emitted.push(data)};
  let executed=false;
  registerSideAgent({ipcMain:{handle:(name,handler)=>{handlers[name]=handler;}},getWindow:()=>({webContents:sender,isDestroyed:()=>false}),getTask:async()=>({id:'main',projectPath:'E:/Nano',history:[{role:'user',content:'main context'}]}),getConfig:async()=>({provider:'openai',model:'fake',permissionMode:'ask'}),getTools:()=>[{name:'write_file',description:'write',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}}],executeTool:async()=>{executed=true;return {ok:true};},getSystemPrompt:async()=>'',runtimeFactory:options=>new AgentRuntime({...options,modelFactory:()=>new FakeModel()})});
  const event={sender};const running=handlers['side:agent-run'](event,{runId:'side-real',taskId:'main',text:'请写文件'});
  for(let i=0;i<100 && !emitted.some(item=>item.type==='approval.required');i++)await new Promise(resolve=>setTimeout(resolve,10));
  const approval=emitted.find(item=>item.type==='approval.required');assert.ok(approval);assert.equal(executed,false);
  assert.equal(handlers['side:agent-approve'](event,{runId:'side-real',approvalId:approval.approvalId,approved:true}),true);
  const result=await running;assert.equal(result.status,'success');assert.equal(executed,true);assert.ok(emitted.some(item=>item.type==='message.delta'&&item.content==='侧聊完成'));
});
