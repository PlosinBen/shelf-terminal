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
  PTY_MUTE: 'pty:mute',

  // Settings
  SETTINGS_LOAD: 'settings:load',
  SETTINGS_SAVE: 'settings:save',

  // SSH
  SSH_LIST_DIR: 'ssh:list-dir',
  SSH_HOME_PATH: 'ssh:home-path',
  SSH_REMOVE_HOST_KEY: 'ssh:remove-host-key',
  CONNECTION_CHECK: 'connection:check',
  CONNECTION_ESTABLISH: 'connection:establish',

  // WSL
  WSL_LIST_DIR: 'wsl:list-dir',
  WSL_HOME_PATH: 'wsl:home-path',
  WSL_LIST_DISTROS: 'wsl:list-distros',

  // Docker
  DOCKER_LIST_DIR: 'docker:list-dir',
  DOCKER_HOME_PATH: 'docker:home-path',
  DOCKER_LIST_CONTAINERS: 'docker:list-containers',

  // Clipboard (Docker)
  CLIPBOARD_SAVE_IMAGE_DOCKER: 'clipboard:save-image-docker',

  // Logs
  LOGS_CLEAR: 'logs:clear',

  // Updater
  UPDATE_CHECK: 'update:check',
  UPDATE_INSTALL: 'update:install',
  UPDATE_STATUS: 'update:status',

  // Main → Renderer (send)
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
} as const;
