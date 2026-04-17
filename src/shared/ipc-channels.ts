export const IPC = {
  // Renderer → Main (invoke)
  PTY_SPAWN: 'pty:spawn',
  PTY_KILL: 'pty:kill',
  PROJECT_LOAD: 'project:load',
  PROJECT_SAVE: 'project:save',
  PROJECT_VALIDATE_DIRS: 'project:validate-dirs',

  // File upload (paste/drag) — generic across local/SSH/WSL/Docker
  FILE_UPLOAD: 'file:upload',
  FILE_CLEAR_UPLOADS: 'file:clear-uploads',

  // Generic dialog from renderer
  DIALOG_WARN: 'dialog:warn',
  DIALOG_CONFIRM: 'dialog:confirm',

  // Renderer → Main (send, no response)
  PTY_INPUT: 'pty:input',
  PTY_RESIZE: 'pty:resize',
  PTY_MUTE: 'pty:mute',

  // Settings
  SETTINGS_LOAD: 'settings:load',
  SETTINGS_SAVE: 'settings:save',

  // Connector (unified)
  CONNECTOR_LIST_DIR: 'connector:list-dir',
  CONNECTOR_HOME_PATH: 'connector:home-path',
  CONNECTOR_CHECK: 'connector:check',
  CONNECTOR_ESTABLISH: 'connector:establish',
  CONNECTOR_AVAILABLE_TYPES: 'connector:available-types',

  // Connector — type-specific operations
  SSH_REMOVE_HOST_KEY: 'ssh:remove-host-key',
  SSH_SERVERS: 'ssh:servers',
  WSL_LIST_DISTROS: 'wsl:list-distros',
  DOCKER_LIST_CONTAINERS: 'docker:list-containers',
  DOCKER_TEST_PATH: 'docker:test-path',

  // Logs
  LOGS_CLEAR: 'logs:clear',

  // App info
  APP_LOGS_PATH: 'app:logs-path',

  // Updater
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  UPDATE_STATUS: 'update:status',

  // Main → Renderer (send)
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
  PTY_INIT_SENT: 'pty:init-sent',
} as const;
