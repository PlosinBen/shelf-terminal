import { CONFIG_EDIT_KEYS, type ConfigEditKey } from '@shared/config-ack';
import { PERMISSION_CONTROL_STRATEGIES, type NativePermissionControlDescriptor } from '@shared/permission-controls';
import type { ProviderCapabilities } from '../types';

export const CODEX_NATIVE_RPC = {
  PROFILES: 'permissionProfile/list', MODES: 'collaborationMode/list', REQUIREMENTS: 'configRequirements/read',
  UPDATE: 'thread/settings/update', UPDATED: 'thread/settings/updated',
} as const;
const APPROVALS = ['untrusted', 'on-request', 'never'] as const;
const CONFIRM_TIMEOUT_MS = 10_000;
interface Client { request<T = unknown>(method: string, params?: unknown): Promise<T> }
type RecordValue = Record<string, any>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex settings response');
  return value as RecordValue;
}

/** Provider-owned effective settings. Explicit prefs remain caller-owned. */
export class CodexNativeControls {
  private settings: RecordValue = {};
  private threadId: string | undefined;
  private profiles: NativePermissionControlDescriptor['options'] = [];
  private modes: NativePermissionControlDescriptor['options'] = [];
  private approvals: NativePermissionControlDescriptor['options'] = [];
  private models: ProviderCapabilities['models'] = [];
  private pending: { key: ConfigEditKey; value: string; resolve: () => void; reject: (error: Error) => void } | undefined;
  private uncertain = false;

  async load(client: Client, cwd: string, models: ProviderCapabilities['models']): Promise<void> {
    this.models = models;
    const profiles: typeof this.profiles = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const response = record(await client.request(CODEX_NATIVE_RPC.PROFILES, { cwd, cursor }));
      if (!Array.isArray(response.data)) throw new Error('Invalid permissionProfile/list response');
      for (const item of response.data) {
        if (typeof item.id !== 'string' || typeof item.allowed !== 'boolean') throw new Error('Invalid permission profile');
        if (item.allowed) profiles.push({ value: item.id, displayName: item.id, ...(item.description ? { description: item.description } : {}) });
      }
      cursor = response.nextCursor ?? null;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated permission profile cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const modes = record(await client.request(CODEX_NATIVE_RPC.MODES));
    if (!Array.isArray(modes.data)) throw new Error('Invalid collaborationMode/list response');
    this.modes = modes.data.map((item: RecordValue) => {
      if (typeof item.mode !== 'string' || typeof item.name !== 'string') throw new Error('Invalid collaboration mode');
      return { value: item.mode, displayName: item.name };
    });
    const requirements = record(await client.request(CODEX_NATIVE_RPC.REQUIREMENTS)).requirements;
    const allowed = requirements?.allowedApprovalPolicies;
    this.approvals = APPROVALS.filter(value => allowed == null || allowed.includes(value)).map(value => ({ value, displayName: value }));
    this.profiles = profiles;
  }

  seed(threadId: string, response: unknown): void {
    const source = record(response);
    if (typeof source.model !== 'string' || source.approvalPolicy === undefined || source.sandbox === undefined) {
      throw new Error('Codex thread response missing effective settings');
    }
    this.threadId = threadId;
    this.uncertain = false;
    this.settings = { model: source.model, effort: source.reasoningEffort ?? null,
      approvalPolicy: source.approvalPolicy, sandboxPolicy: source.sandbox,
      activePermissionProfile: source.activePermissionProfile ?? null };
  }

  observe(payload: unknown): void {
    const source = record(payload);
    if (source.threadId !== this.threadId) return;
    const settings = record(source.threadSettings);
    if (typeof settings.model !== 'string' || !settings.collaborationMode || settings.approvalPolicy === undefined) {
      throw new Error('Codex settings notification missing effective settings');
    }
    this.settings = settings;
    if (this.pending && this.value(this.pending.key) === this.pending.value) this.pending.resolve();
  }

  value(key: ConfigEditKey): string | undefined {
    switch (key) {
      case CONFIG_EDIT_KEYS.MODEL: return this.settings.model;
      case CONFIG_EDIT_KEYS.EFFORT: return this.settings.effort ?? undefined;
      case CONFIG_EDIT_KEYS.NATIVE_MODE: return this.settings.collaborationMode?.mode;
      case CONFIG_EDIT_KEYS.NATIVE_PERMISSION: return this.settings.activePermissionProfile?.id;
      case CONFIG_EDIT_KEYS.NATIVE_APPROVAL: return typeof this.settings.approvalPolicy === 'string' ? this.settings.approvalPolicy : undefined;
      default: return undefined;
    }
  }

  private options(key: ConfigEditKey) {
    switch (key) {
      case CONFIG_EDIT_KEYS.MODEL: return this.models;
      case CONFIG_EDIT_KEYS.EFFORT: return this.models.find(m => m.value === this.settings.model)?.effortLevels;
      case CONFIG_EDIT_KEYS.NATIVE_MODE: return this.modes;
      case CONFIG_EDIT_KEYS.NATIVE_PERMISSION: return this.profiles;
      case CONFIG_EDIT_KEYS.NATIVE_APPROVAL: return this.approvals;
      default: throw new Error('Codex requires native configuration keys');
    }
  }

  validate(key: ConfigEditKey, value: string): void {
    const options = this.options(key);
    // An absent model catalog cannot establish that a saved selection is invalid.
    if (options && (key !== CONFIG_EDIT_KEYS.MODEL || options.length > 0) && !options.some(option => option.value === value)) {
      throw new Error(`Codex did not advertise saved ${key} value "${value}"`);
    }
  }

  assertUsable(): void {
    if (!this.threadId || this.uncertain) throw new Error('Codex settings unavailable; reconnect before continuing');
  }

  async apply(client: Client, key: ConfigEditKey, value: string): Promise<boolean> {
    this.assertUsable();
    this.validate(key, value);
    if (this.value(key) === value) return false;
    if (key === CONFIG_EDIT_KEYS.MODEL && this.settings.effort != null) {
      const supported = this.models.find(model => model.value === value)?.effortLevels;
      if (supported && !supported.some(option => option.value === this.settings.effort)) {
        throw new Error(`Model ${value} does not support current effort ${this.settings.effort}; change effort before switching model`);
      }
    }
    if (this.pending) throw new Error('Codex settings update already pending');
    const params: RecordValue = { threadId: this.threadId };
    switch (key) {
      case CONFIG_EDIT_KEYS.MODEL: params.model = value; break;
      case CONFIG_EDIT_KEYS.EFFORT: params.effort = value; break;
      case CONFIG_EDIT_KEYS.NATIVE_PERMISSION: params.permissions = value; break;
      case CONFIG_EDIT_KEYS.NATIVE_APPROVAL: params.approvalPolicy = value; break;
      case CONFIG_EDIT_KEYS.NATIVE_MODE:
        params.collaborationMode = { mode: value, settings: { model: this.settings.model,
          reasoning_effort: this.settings.effort ?? null, developer_instructions: null } }; break;
      default: throw new Error('Unsupported Codex config edit');
    }
    const before = this.settings;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const confirmed = new Promise<void>((resolve, reject) => {
      this.pending = { key, value, resolve, reject };
      timer = setTimeout(() => reject(new Error(`Codex settings confirmation timed out: ${key}`)), CONFIRM_TIMEOUT_MS);
    });
    try {
      await Promise.all([client.request(CODEX_NATIVE_RPC.UPDATE, params).then(() => {
        // Start/resume does not expose mode. An acknowledged explicit mode apply
        // establishes it even when the server suppresses a same-value notification.
        if (key === CONFIG_EDIT_KEYS.NATIVE_MODE && !before.collaborationMode && !this.settings.collaborationMode) {
          this.settings = { ...this.settings, collaborationMode: params.collaborationMode };
          this.pending?.resolve();
        }
      }), confirmed]);
      return true;
    } catch (error) {
      this.settings = before;
      // A transport error may follow an upstream mutation. Do not reuse an uncertain snapshot.
      this.uncertain = true;
      throw error;
    } finally {
      clearTimeout(timer);
      this.pending = undefined;
    }
  }

  dispose(): void {
    this.pending?.reject(new Error('Codex settings session closed'));
    this.pending = undefined;
    this.threadId = undefined;
    this.settings = {};
  }

  capabilities(): Pick<ProviderCapabilities, 'permissionControl' | 'effortLevels' | 'currentModel' | 'currentEffort'> {
    const descriptor = (label: string, key: ConfigEditKey, options: NativePermissionControlDescriptor['options']): NativePermissionControlDescriptor => ({
      label, options, currentValue: this.value(key),
      currentDisplayName: this.value(key) ? undefined : label === 'Approval' || label === 'Permission' ? 'Custom' : 'Default',
    });
    return {
      currentModel: this.value(CONFIG_EDIT_KEYS.MODEL), currentEffort: this.value(CONFIG_EDIT_KEYS.EFFORT),
      effortLevels: this.models.find(m => m.value === this.settings.model)?.effortLevels ?? [],
      permissionControl: { strategy: PERMISSION_CONTROL_STRATEGIES.NATIVE,
        mode: descriptor('Mode', CONFIG_EDIT_KEYS.NATIVE_MODE, this.modes),
        permission: descriptor('Permission', CONFIG_EDIT_KEYS.NATIVE_PERMISSION, this.profiles),
        approval: descriptor('Approval', CONFIG_EDIT_KEYS.NATIVE_APPROVAL, this.approvals) },
    };
  }
}
