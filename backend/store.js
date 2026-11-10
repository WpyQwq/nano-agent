const fs = require('node:fs/promises');
const path = require('node:path');

class Store {
  constructor(directory, encryption) { this.directory = directory; this.encryption = encryption; this.queue = Promise.resolve(); this.taskCache = null; }
  async read(name, fallback) {
    try { return JSON.parse(await fs.readFile(path.join(this.directory, `${name}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`无法读取本地${name}数据：${error.message}`); }
  }
  write(name, value) {
    const operation = this.queue.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const target = path.join(this.directory, `${name}.json`);
      await fs.writeFile(`${target}.tmp`, JSON.stringify(value, null, 2), 'utf8');
      await fs.rename(`${target}.tmp`, target);
    });
    this.queue = operation;
    return operation;
  }
  async settings() {
    const config = await this.read('settings', { provider: 'demo', model: '', permissionMode: 'ask', theme: 'dark', fontSize: 14, maxSteps: 20 });
    const { encryptedKey, ...publicConfig } = config;
    if(publicConfig.mcpServers)publicConfig.mcpServers=publicConfig.mcpServers.map(({encryptedEnv,env,...server})=>({...server,hasEnv:Boolean(encryptedEnv)}));
    return { ...publicConfig, hasApiKey: Boolean(encryptedKey) };
  }
  saveSettings(input) {
    const operation=this.queue.catch(()=>{}).then(async()=>{
    const previous = await this.read('settings', {});
    const allowed = ['provider', 'model', 'baseUrl', 'permissionMode', 'theme', 'fontSize', 'maxSteps', 'systemPrompt', 'mcpServers', 'selectedModel'];
    const next = { ...previous };
    for (const key of allowed) if (input[key] !== undefined) next[key] = input[key];
    if(input.mcpServers!==undefined){
      if(!Array.isArray(input.mcpServers) || input.mcpServers.length>30)throw new Error('MCP 配置最多包含 30 个扩展');
      next.mcpServers=input.mcpServers.map(({env,hasEnv,encryptedEnv:ignored,clearEnv,...server})=>{
        const previousServer=previous.mcpServers?.find(item=>item.id===server.id);
        const result={...server,...(previousServer?.encryptedEnv && !clearEnv?{encryptedEnv:previousServer.encryptedEnv}:{})};
        if(env && Object.keys(env).length){if(!this.encryption.isEncryptionAvailable())throw new Error('系统加密不可用，环境变量未保存');result.encryptedEnv=this.encryption.encryptString(JSON.stringify(env)).toString('base64');}
        return result;
      });
    }
    if (input.clearApiKey) delete next.encryptedKey;
    if (input.apiKey) {
      if (!this.encryption.isEncryptionAvailable()) throw new Error('系统加密不可用，密钥未保存');
      next.encryptedKey = this.encryption.encryptString(input.apiKey).toString('base64');
    }
    await fs.mkdir(this.directory,{recursive:true});
    const target=path.join(this.directory,'settings.json');await fs.writeFile(`${target}.tmp`,JSON.stringify(next,null,2),'utf8');await fs.rename(`${target}.tmp`,target);
    return this.settings();
    });this.queue=operation;return operation;
  }
  async privateSettings() {
    const config = await this.read('settings', {});
    if (config.encryptedKey) config.apiKey = this.encryption.decryptString(Buffer.from(config.encryptedKey, 'base64'));
    if(config.mcpServers)config.mcpServers=config.mcpServers.map(({encryptedEnv,...server})=>({...server,...(encryptedEnv?{env:JSON.parse(this.encryption.decryptString(Buffer.from(encryptedEnv,'base64')))}:{})}));
    delete config.encryptedKey;
    return config;
  }
  async tasks() { if(!this.taskCache)this.taskCache=await this.read('tasks', []); return structuredClone(this.taskCache); }
  saveTask(task) {
    // Serialize read-modify-write as well as the write itself.
    const operation = this.queue.catch(() => {}).then(async () => {
      const tasks = await this.tasks();
      const index = tasks.findIndex((item) => item.id === task.id);
      if (index < 0) tasks.unshift(task); else tasks[index] = task;
      await fs.mkdir(this.directory, { recursive: true });
      const target = path.join(this.directory, 'tasks.json');
      await fs.writeFile(`${target}.tmp`, JSON.stringify(tasks), 'utf8');
      await fs.rename(`${target}.tmp`, target);
      this.taskCache = tasks;
      return task;
    });
    this.queue = operation;
    return operation;
  }
  patchTask(id, changes) {
    const operation=this.queue.catch(()=>{}).then(async()=>{
      const tasks=await this.tasks();const index=tasks.findIndex(task=>task.id===id);if(index<0)throw new Error('会话不存在');
      tasks[index]={...tasks[index],...changes};await fs.mkdir(this.directory,{recursive:true});const target=path.join(this.directory,'tasks.json');
      await fs.writeFile(`${target}.tmp`,JSON.stringify(tasks),'utf8');await fs.rename(`${target}.tmp`,target);this.taskCache=tasks;return structuredClone(tasks[index]);
    });this.queue=operation;return operation;
  }
}
module.exports = { Store };
