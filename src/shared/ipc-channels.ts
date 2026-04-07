export const IPC = {
  // Renderer → Main (invoke)
  PTY_SPAWN: 'pty:spawn',
  PTY_KILL: 'pty:kill',
  FOLDER_LIST: 'folder:list',
  HOME_PATH: 'folder:home',
  PROJECT_LOAD: 'project:load',
  PROJECT_SAVE: 'project:save',
  CLIPBOARD_SAVE_IMAGE: 'clipboard:save-image',
  CLIPBOARD_SAVE_IMAGE_REMOTE: 'clipboard:save-image-remote',

  // Renderer → Main (send, no response)
  PTY_INPUT: 'pty:input',
  PTY_RESIZE: 'pty:resize',

  // Settings
  SETTINGS_LOAD: 'settings:load',
  SETTINGS_SAVE: 'settings:save',

  // SSH
  SSH_LIST_DIR: 'ssh:list-dir',

  // Main → Renderer (send)
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
} as const;
