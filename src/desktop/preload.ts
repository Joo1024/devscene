import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('workscene', {
  call: (action: string, payload?: unknown) => ipcRenderer.invoke('workscene',action,payload)
});
