const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nano', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  listProjectFiles: (projectPath) => ipcRenderer.invoke('project:files', projectPath),
  readProjectFile: (payload) => ipcRenderer.invoke('project:read', payload),
  searchProject: (payload) => ipcRenderer.invoke('project:search', payload),
  writeProjectFile: (payload) => ipcRenderer.invoke('project:write', payload),
  runCommand: (payload) => ipcRenderer.invoke('shell:run', payload),
  openPath: (target) => ipcRenderer.invoke('shell:open', target),
  computerAction: (action) => ipcRenderer.invoke('computer:action', action),
  listWindows: () => ipcRenderer.invoke('computer:windows'),
  runAgent: (payload) => ipcRenderer.invoke('agent:run', payload),
  onAgentEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  }
});
