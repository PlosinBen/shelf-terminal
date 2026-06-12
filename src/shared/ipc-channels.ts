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
  FILE_UPLOADS_SIZE: 'file:uploads-size',

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

  // Git
  GIT_BRANCH_LIST: 'git:branch-list',
  GIT_CHECK_DIRTY: 'git:check-dirty',
  GIT_CHECKOUT: 'git:checkout',
  GIT_WORKTREE_ADD: 'git:worktree-add',
  GIT_WORKTREE_REMOVE: 'git:worktree-remove',

  // Notes (per-project markdown scratch pad — multiple notes per project)
  NOTES_LIST: 'notes:list',
  NOTES_GET: 'notes:get',
  NOTES_CREATE: 'notes:create',
  NOTES_QUICK_CREATE: 'notes:quick-create',
  NOTES_UPDATE: 'notes:update',
  NOTES_DELETE: 'notes:delete',
  NOTES_DELETE_ALL_DONE: 'notes:delete-all-done',
  NOTES_SAVE_IMAGE: 'notes:save-image',
  NOTES_READ_IMAGE: 'notes:read-image',

  // Skills (app-level Agent Skills — one folder per skill under userData)
  SKILLS_LIST: 'skills:list',
  SKILLS_GET: 'skills:get',
  SKILLS_CREATE: 'skills:create',
  SKILLS_UPDATE: 'skills:update',
  SKILLS_DELETE: 'skills:delete',
  // main→renderer: app-level skills changed (by the manager UI OR the agent
  // bridge) — the SkillsView refetches its list. See skills-sync.ts.
  SKILLS_CHANGED: 'skills:changed',

  // Logs
  LOGS_CLEAR: 'logs:clear',
  LOGS_SIZE: 'logs:size',

  // App info
  APP_LOGS_PATH: 'app:logs-path',

  // Updater
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  UPDATE_STATUS: 'update:status',

  // Agent (Renderer → Main)
  AGENT_INIT: 'agent:init',
  AGENT_SEND: 'agent:send',
  AGENT_STOP: 'agent:stop',
  AGENT_DESTROY: 'agent:destroy',
  AGENT_RESOLVE_PERMISSION: 'agent:resolve-permission',
  AGENT_RESOLVE_PICKER: 'agent:resolve-picker',
  AGENT_STORE_CREDENTIAL: 'agent:store-credential',
  AGENT_CLEAR_CREDENTIAL: 'agent:clear-credential',
  AGENT_CHECK_AUTH: 'agent:check-auth',
  /** Read a background task's full remote output_file (invoke). See DECISIONS #69. */
  AGENT_READ_TASK_OUTPUT: 'agent:read-task-output',
  /** Stop a running background task (fire-and-forget; SDK emits task_notification
   *  'stopped' which flows back via AGENT_BACKGROUND_TASKS). See DECISIONS #72. */
  AGENT_STOP_TASK: 'agent:stop-task',

  // PM Agent
  PM_SEND: 'pm:send',
  PM_STOP: 'pm:stop',
  PM_HISTORY: 'pm:history',
  PM_CLEAR: 'pm:clear',
  PM_COMPACT: 'pm:compact',
  PM_SYNC_STATE: 'pm:sync-state',
  PM_AWAY_MODE: 'pm:away-mode',
  PM_AWAY_MODE_GET: 'pm:away-mode-get',
  PM_ACTIVE: 'pm:active',
  PM_SET_ACTIVE: 'pm:set-active',
  PM_ACTIVE_GET: 'pm:active-get',
  PM_ACTIVE_ERROR: 'pm:active-error',
  PM_ESCALATION_RESPOND: 'pm:escalation-respond',
  PM_LIST_MODELS: 'pm:list-models',

  // Main → Renderer (send)
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
  PTY_INIT_SENT: 'pty:init-sent',
  PM_STREAM: 'pm:stream',

  // Agent (Main → Renderer)
  AGENT_MESSAGE: 'agent:message',
  AGENT_STREAM: 'agent:stream',
  AGENT_STATUS: 'agent:status',
  AGENT_PLAN: 'agent:plan',
  AGENT_PERMISSION_REQUEST: 'agent:permission-request',
  AGENT_PICKER_REQUEST: 'agent:picker-request',
  AGENT_CAPABILITIES: 'agent:capabilities',
  AGENT_AUTH_REQUIRED: 'agent:auth-required',
  AGENT_INIT_STATUS: 'agent:init-status',
  /** Background task updates (turnId-less; see DECISIONS #69). Carries a TaskEvent. */
  AGENT_BACKGROUND_TASKS: 'agent:background-tasks',
  /** Per-agent-server connection health from the heartbeat round-trip. Carries a ConnectionHealth. */
  AGENT_CONNECTION_HEALTH: 'agent:connection-health',
} as const;
