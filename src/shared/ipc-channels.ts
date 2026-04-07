export const IPC = {
  // Renderer → Main (invoke)
  PTY_SPAWN: 'pty:spawn',
  PTY_KILL: 'pty:kill',
  FOLDER_LIST: 'folder:list',
  HOME_PATH: 'folder:home',
  PROJECT_LOAD: 'project:load',
  PROJECT_SAVE: 'project:save',
  CLIPBOARD_SAVE_IMAGE: 'clipboard:save-image',

  // Renderer → Main (send, no response)
  PTY_INPUT: 'pty:input',
  PTY_RESIZE: 'pty:resize',

  // Main → Renderer (send)
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
} as const;
