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
  SKILLS_SET_LOCKED: 'skills:set-locked',
  // Aux files inside a skill folder (scripts/reference docs — NOT SKILL.md, which
  // goes through SKILLS_GET/UPDATE). Mirror the skills-store aux-file fns.
  SKILLS_LIST_FILES: 'skills:list-files',
  SKILLS_READ_FILE: 'skills:read-file',
  SKILLS_WRITE_FILE: 'skills:write-file',
  SKILLS_DELETE_FILE: 'skills:delete-file',
  // main→renderer: app-level skills changed (by the manager UI OR the agent
  // bridge) — the SkillsView refetches its list. See skills-sync.ts.
  SKILLS_CHANGED: 'skills:changed',

  // MCP (app-level external MCP servers — single mcp-servers.json under userData)
  MCP_LIST: 'mcp:list',
  MCP_GET: 'mcp:get',
  MCP_ADD: 'mcp:add',
  MCP_UPDATE: 'mcp:update',
  MCP_REMOVE: 'mcp:remove',
  // main→renderer: app-level MCP config changed — the settings view refetches.
  // Sibling of SKILLS_CHANGED; see mcp-sync.ts.
  MCP_CHANGED: 'mcp:changed',

  // Logs
  LOGS_CLEAR: 'logs:clear',
  LOGS_SIZE: 'logs:size',

  // In-page find (renderer→main: drive webContents.findInPage for DOM-based
  // tabs — agent / web — where there's no xterm SearchAddon). Terminal tabs
  // keep using the xterm addon. See SearchBar.
  WINDOW_FIND: 'window:find',
  WINDOW_STOP_FIND: 'window:stop-find',
  // main→renderer: forwarded 'found-in-page' result (active ordinal + match count)
  WINDOW_FIND_RESULT: 'window:find-result',

  // Web session (login surface + agent web.fetch management)
  WEB_LIST_SESSIONS: 'web:list-sessions',
  WEB_DELETE_SESSION: 'web:delete-session',
  WEB_LIST_GRANTS: 'web:list-grants',
  WEB_REVOKE_GRANT: 'web:revoke-grant',
  // web.fetch per-origin permission popup (main→renderer request, renderer→main resolve)
  WEB_PERMISSION_REQUEST: 'web:permission-request',
  WEB_PERMISSION_RESOLVE: 'web:permission-resolve',
  // main→renderer: a pending web-permission was resolved elsewhere (Telegram /
  // timeout) → dismiss the local popup.
  WEB_PERMISSION_CLOSE: 'web:permission-close',

  // App info
  APP_LOGS_PATH: 'app:logs-path',
  // renderer→main fire-and-forget diagnostic log → main log file (persists when
  // log level is info/debug). For tracing UI flows unobservable from outside the
  // renderer. See src/renderer/debugLog.ts.
  APP_DEBUG_LOG: 'app:debug-log',

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
  /** Read a background task's full remote output_file (invoke). See background-tasks#2. */
  AGENT_READ_TASK_OUTPUT: 'agent:read-task-output',
  /** Stop a running background task (fire-and-forget; SDK emits task_notification
   *  'stopped' which flows back via AGENT_BACKGROUND_TASKS). See background-tasks#3. */
  AGENT_STOP_TASK: 'agent:stop-task',
  /** Cancel a specific not-yet-running queued message by clientMsgId
   *  (fire-and-forget). Server drops it from its queue + re-emits AGENT_QUEUE.
   *  No-op once the message is running. See message-queue-ownership design. */
  AGENT_CANCEL_QUEUED: 'agent:cancel-queued',

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
  /** Background task updates (turnId-less; see background-tasks#2). Carries a TaskEvent. */
  AGENT_BACKGROUND_TASKS: 'agent:background-tasks',
  /** Server-owned send-queue snapshot (session-level, turnId-less). Carries the
   *  full ordered AgentQueueItem[] of in-flight client sends. Renderer mirrors
   *  it. See message-queue-ownership design. */
  AGENT_QUEUE: 'agent:queue',
  /** Per-agent-server connection health from the heartbeat round-trip. Carries a ConnectionHealth. */
  AGENT_CONNECTION_HEALTH: 'agent:connection-health',
} as const;
