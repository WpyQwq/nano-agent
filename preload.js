const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('nano', {
  appInfo: invoke('app:info'), windowControl: invoke('window:control'),
  chooseProject: invoke('project:choose'), listProjectFiles: invoke('project:files'),
  readProjectFile: invoke('project:read'), searchProject: invoke('project:search'), git: invoke('project:git'),
  runCommand: invoke('shell:run'), cancelCommand: invoke('shell:cancel'), openPath: invoke('shell:open'), openExternal: invoke('shell:external'),
  computerAction: invoke('computer:action'), listWindows: invoke('computer:windows'),
  loadSettings: invoke('settings:load'), saveSettings: invoke('settings:save'), testConnection: invoke('settings:test'),
  listTasks: invoke('tasks:list'), saveTask: invoke('tasks:save'), exportTask: invoke('tasks:export'), compactTask: invoke('tasks:compact'),
  runAgent: invoke('agent:run'), cancelAgent: invoke('agent:cancel'), approve: invoke('agent:approve'),
  answerQuestion: invoke('agent:answer'),
  loadCampus: invoke('campus:load'), saveCampusNote: invoke('campus:note'), saveCampusTask: invoke('campus:task'),
  listModels: invoke('models:list'), saveModel: invoke('models:save'), removeModel: invoke('models:remove'), discoverModels: invoke('models:discover'), selectModel: invoke('models:select'),
  setPermission: invoke('agent:permission'), suggestTitle: invoke('tasks:title'),
  steerAgent: invoke('agent:steer'), sideAgentRun:invoke('side:agent-run'),sideAgentCancel:invoke('side:agent-cancel'),sideAgentPermission:invoke('side:agent-permission'),sideAgentApprove:invoke('side:agent-approve'),sideAgentAnswer:invoke('side:agent-answer'),
  onSideAgentEvent:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on('side:agent-event',listener);return()=>ipcRenderer.removeListener('side:agent-event',listener);},
  sideBrowserOpen: invoke('side:browser-open'), sideBrowserBounds: invoke('side:browser-bounds'), sideBrowserAction: invoke('side:browser-action'), sideFileRead: invoke('side:file-hash'), sideFileSave: invoke('side:save-file'),
  sideChat: invoke('side:chat'),
  onSideBrowserState: callback => {const listener=(_event,data)=>callback(data);ipcRenderer.on('side:browser-state',listener);return()=>ipcRenderer.removeListener('side:browser-state',listener);},
  onSideBrowserError: callback => {const listener=(_event,data)=>callback(data);ipcRenderer.on('side:browser-error',listener);return()=>ipcRenderer.removeListener('side:browser-error',listener);},
  listChanges: invoke('changes:list'), acceptChange: invoke('changes:accept'), restoreChange: invoke('changes:restore'),
  mcpStatus: invoke('mcp:status'), connectMcp: invoke('mcp:connect'), disconnectMcp: invoke('mcp:disconnect'),
  onCommandOutput: (callback) => {
    const listener = (_event,data) => callback(data); ipcRenderer.on('shell:event',listener);
    return () => ipcRenderer.removeListener('shell:event',listener);
  },
  onAgentEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  }
});
