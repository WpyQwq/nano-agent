'use strict';
const { randomUUID } = require('node:crypto');

const MAX_NOTES=100;
function clean(value, length=2000) { return String(value || '').trim().slice(0,length); }

class Campus {
  constructor(store) { this.store=store;this.queue=Promise.resolve(); }
  async load() { const data=await this.store.read('campus',{notes:[],tasks:[]});return {notes:Array.isArray(data.notes)?data.notes:[],tasks:Array.isArray(data.tasks)?data.tasks:[]}; }
  change(action) {
    const operation=this.queue.catch(()=>{}).then(async()=>{const data=await this.load();const result=await action(data);await this.store.write('campus',data);return result;});
    this.queue=operation;return operation;
  }
  async search(query) {
    const terms=clean(query,100).toLowerCase().split(/\s+/).filter(Boolean);if(!terms.length)throw new Error('请输入搜索内容');
    const {notes}=await this.load();return notes.filter(note=>terms.some(term=>`${note.title}\n${note.content}`.toLowerCase().includes(term))).map(({id,title,content,updatedAt})=>({id,title,content,updatedAt})).slice(0,12);
  }
  saveNote({id,title,content}) {
    title=clean(title,100);content=clean(content,12000);if(!title||!content)throw new Error('标题和内容不能为空');
    return this.change(data=>{const index=data.notes.findIndex(n=>n.id===id);if(index<0&&data.notes.length>=MAX_NOTES)throw new Error('校园资料最多保存 100 条');const note={id:index<0?randomUUID():id,title,content,updatedAt:Date.now()};if(index<0)data.notes.unshift(note);else data.notes[index]=note;return note;});
  }
  saveTask({id,title,dueDate='',completed=false}) {
    title=clean(title,200);dueDate=clean(dueDate,10);if(!title)throw new Error('事项不能为空');
    if(dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)||Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`))))throw new Error('日期格式应为 YYYY-MM-DD');
    return this.change(data=>{const index=data.tasks.findIndex(t=>t.id===id);if(index<0&&data.tasks.length>=300)throw new Error('待办最多保存 300 条');const task={id:index<0?randomUUID():id,title,dueDate,completed:Boolean(completed),updatedAt:Date.now()};if(index<0)data.tasks.unshift(task);else data.tasks[index]=task;return task;});
  }
}
module.exports={Campus};
