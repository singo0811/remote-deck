import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import {
  LanEndpoint,
  RecentDeviceItem,
  jsonArr,
  jsonAsObject,
  jsonNum,
  jsonStr,
} from '../protocol/Protocol';

const STORE_NAME = 'remotedeck_prefs';
const KEY_RECENT = 'recent_devices';
const KEY_LAST_SERVER = 'last_server_url';
const KEY_LAST_MODE = 'last_mode';
const KEY_TSNET_ENABLED = 'tsnet_enabled';
const KEY_TSNET_AUTH_KEY = 'tsnet_auth_key';

function parseStoredEndpoints(arr: Object[]): LanEndpoint[] {
  const out: LanEndpoint[] = [];
  for (let i = 0; i < arr.length; i++) {
    const ep = jsonAsObject(arr[i]);
    if (!ep) continue;
    const wsUrl = jsonStr(ep, 'wsUrl');
    if (!wsUrl) continue;
    out.push({
      iface: jsonStr(ep, 'iface'),
      ip: jsonStr(ep, 'ip'),
      kind: jsonStr(ep, 'kind', 'lan'),
      wsUrl,
      httpUrl: jsonStr(ep, 'httpUrl'),
    });
  }
  return out;
}

export class RecentStore {
  private static instance: RecentStore | null = null;
  private pref: preferences.Preferences | null = null;

  static getInstance(): RecentStore {
    if (!RecentStore.instance) {
      RecentStore.instance = new RecentStore();
    }
    return RecentStore.instance;
  }

  async init(context: common.Context): Promise<void> {
    if (this.pref) return;
    try {
      this.pref = await preferences.getPreferences(context, STORE_NAME);
    } catch {
      this.pref = null;
    }
  }

  async loadRecent(): Promise<RecentDeviceItem[]> {
    if (!this.pref) return [];
    try {
      const raw = await this.pref.get(KEY_RECENT, '[]') as string;
      const arr = JSON.parse(raw) as Object[];
      if (!Array.isArray(arr)) return [];
      const out: RecentDeviceItem[] = [];
      for (let i = 0; i < arr.length; i++) {
        const obj = arr[i] as Record<string, Object>;
        const deviceId = jsonStr(obj, 'deviceId');
        const serverUrl = jsonStr(obj, 'serverUrl');
        if (!deviceId && !serverUrl) continue;
        out.push({
          mode: jsonStr(obj, 'mode', 'relay'),
          serverUrl,
          deviceId,
          deviceName: jsonStr(obj, 'deviceName', deviceId),
          pin: jsonStr(obj, 'pin'),
          tunnelUrl: jsonStr(obj, 'tunnelUrl'),
          lanEndpoints: parseStoredEndpoints(jsonArr(obj, 'lanEndpoints')),
          updatedAt: jsonNum(obj, 'updatedAt', 0),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  async saveRecent(entry: RecentDeviceItem): Promise<RecentDeviceItem[]> {
    const existing = await this.loadRecent();
    let mergedTunnel = entry.tunnelUrl || '';
    let mergedEndpoints: LanEndpoint[] = entry.lanEndpoints || [];
    const rest: RecentDeviceItem[] = [];
    for (let i = 0; i < existing.length; i++) {
      const item = existing[i];
      const sameDevice =
        entry.deviceId.length > 0 && entry.deviceId !== 'DIRECT'
          ? item.deviceId === entry.deviceId
          : item.deviceId === entry.deviceId && item.serverUrl === entry.serverUrl;
      if (sameDevice) {
        if (!mergedTunnel && item.tunnelUrl) {
          mergedTunnel = item.tunnelUrl;
        }
        if (mergedEndpoints.length === 0 && item.lanEndpoints && item.lanEndpoints.length > 0) {
          mergedEndpoints = item.lanEndpoints;
        }
        continue;
      }
      rest.push(item);
    }
    const mergedEntry: RecentDeviceItem = {
      mode: entry.mode,
      serverUrl: entry.serverUrl,
      deviceId: entry.deviceId,
      deviceName: entry.deviceName,
      pin: entry.pin,
      tunnelUrl: mergedTunnel,
      lanEndpoints: mergedEndpoints,
      updatedAt: entry.updatedAt,
    };
    const filtered: RecentDeviceItem[] = [mergedEntry];
    for (let i = 0; i < rest.length; i++) {
      filtered.push(rest[i]);
      if (filtered.length >= 8) break;
    }
    if (this.pref) {
      try {
        await this.pref.put(KEY_RECENT, JSON.stringify(filtered));
        await this.pref.put(KEY_LAST_SERVER, entry.serverUrl);
        await this.pref.put(KEY_LAST_MODE, entry.mode);
        await this.pref.flush();
      } catch {
        // Ignore storage error
      }
    }
    return filtered;
  }

  async loadLastServer(): Promise<string> {
    if (!this.pref) return '';
    try {
      return await this.pref.get(KEY_LAST_SERVER, '') as string;
    } catch {
      return '';
    }
  }

  async loadLastMode(): Promise<string> {
    if (!this.pref) return 'relay';
    try {
      return await this.pref.get(KEY_LAST_MODE, 'relay') as string;
    } catch {
      return 'relay';
    }
  }

  async loadTsnetEnabled(): Promise<boolean> {
    if (!this.pref) return false;
    try {
      return await this.pref.get(KEY_TSNET_ENABLED, false) as boolean;
    } catch {
      return false;
    }
  }

  async saveTsnetEnabled(enabled: boolean): Promise<void> {
    if (!this.pref) return;
    try {
      await this.pref.put(KEY_TSNET_ENABLED, enabled);
      await this.pref.flush();
    } catch {
      // Ignore storage error
    }
  }

  async loadTsnetAuthKey(): Promise<string> {
    if (!this.pref) return '';
    try {
      return await this.pref.get(KEY_TSNET_AUTH_KEY, '') as string;
    } catch {
      return '';
    }
  }

  async saveTsnetAuthKey(authKey: string): Promise<void> {
    if (!this.pref) return;
    try {
      await this.pref.put(KEY_TSNET_AUTH_KEY, authKey);
      await this.pref.flush();
    } catch {
      // Ignore storage error
    }
  }
}
