'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {Campus}=require('../backend/campus');const {Store}=require('../backend/store');
test('campus notes are searchable and persist after restart, with explicit source',async()=>{
  const dir=await fs.mkdtemp('E:/Nano-QA/campus-test-');const store=new Store(dir,{}),campus=new Campus(store);
  const note=await campus.saveNote({title:'图书馆开放时间',content:'周一至周五 16:00 开放（测试数据）'});
  assert.equal((await campus.search('图书馆'))[0].id,note.id);assert.equal((await campus.search('食堂')).length,0);
  assert.equal((await new Campus(new Store(dir,{})).load()).notes[0].title,note.title);
  assert.throws(()=>campus.saveNote({title:'',content:'无效'}),/不能为空/);
});
test('tasks and notes can be saved concurrently without losing data',async()=>{
  const dir=await fs.mkdtemp('E:/Nano-QA/campus-test-');const campus=new Campus(new Store(dir,{}));
  await Promise.all([campus.saveTask({title:'复习数学',dueDate:'2026-11-20'}),campus.saveNote({title:'活动',content:'仅供测试'})]);
  let data=await campus.load();assert.equal(data.tasks.length,1);assert.equal(data.notes.length,1);
  await campus.saveTask({...data.tasks[0],completed:true});data=await campus.load();assert.equal(data.tasks[0].completed,true);
  assert.throws(()=>campus.saveTask({title:'事项',dueDate:'bad'}),/日期/);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'campus.json'),'utf8')).notes.length,1);
});
test('LangChain agent can answer from campus material and request approval for a task',async()=>{
  const {AgentRuntime}=require('../backend/agent');const {BaseChatModel}=require('@langchain/core/language_models/chat_models');const {AIMessageChunk}=require('@langchain/core/messages');const {ChatGenerationChunk}=require('@langchain/core/outputs');
  class FakeModel extends BaseChatModel{constructor(){super({});this.calls=0;}_llmType(){return 'campus-test';}bindTools(){return this;}async _generate(){throw new Error('stream required');}async *_streamResponseChunks(){const actions=[{name:'campus_search',args:{query:'图书馆'},id:'search-1'},{name:'campus_add_task',args:{title:'去图书馆'},id:'add-1'}];const call=actions[this.calls++];const message=new AIMessageChunk(call?{content:'',tool_calls:[{...call,type:'tool_call'}]}:{content:'已查询图书馆资料并添加待办。'});yield new ChatGenerationChunk({message,text:message.content});}}
  const dir=await fs.mkdtemp('E:/Nano-QA/campus-agent-');const campus=new Campus(new Store(dir,{}));await campus.saveNote({title:'图书馆',content:'周一开放（测试数据）'});
  const definitions=[{name:'campus_search',description:'搜索',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}},{name:'campus_add_task',description:'添加',requiresApproval:true,parameters:{type:'object',properties:{title:{type:'string'}},required:['title']}}];
  const runtime=new AgentRuntime({toolDefinitions:definitions,executeTool:(name,input)=>name==='campus_search'?campus.search(input.query):campus.saveTask(input),modelFactory:()=>new FakeModel()});
  const events=[];const result=await runtime.run({runId:'campus-test',taskId:'campus-task',config:{provider:'openai',model:'mock'},permissionMode:'ask',messages:[{role:'user',content:'查询图书馆并添加待办'}]},event=>{events.push(event);if(event.type==='approval.required')runtime.approve({runId:event.runId,approvalId:event.approvalId,approved:true});});
  assert.equal(result.status,'success');assert.equal(events.filter(event=>event.type==='tool.completed').length,2);assert.equal((await campus.load()).tasks[0].title,'去图书馆');assert(events.some(event=>event.type==='approval.required'));
});
