import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { KeyboardAvoidMode, window } from '@kit.ArkUI';
import { RecentStore } from '../storage/RecentStore';
import { parseConnectUrl } from '../protocol/Protocol';

export class WindowController {
  private static mainWin: window.Window | null = null;

  static setMainWindow(win: window.Window): void {
    WindowController.mainWin = win;
  }

  static setOrientationMode(mode: string): void {
    const win = WindowController.mainWin;
    if (!win) return;
    if (mode === 'landscape') {
      win.setPreferredOrientation(window.Orientation.AUTO_ROTATION_LANDSCAPE).catch(() => {});
      win.setWindowSystemBarEnable([]).catch(() => {});
    } else if (mode === 'portrait') {
      win.setPreferredOrientation(window.Orientation.PORTRAIT).catch(() => {});
      win.setWindowSystemBarEnable(['status', 'navigation']).catch(() => {});
    } else {
      win.setPreferredOrientation(window.Orientation.AUTO_ROTATION_RESTRICTED).catch(() => {});
      win.setWindowSystemBarEnable(['status', 'navigation']).catch(() => {});
    }
  }
}

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    this.captureWantUri(want);
  }

  onNewWant(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    this.captureWantUri(want);
  }

  private captureWantUri(want: Want): void {
    const rawUri = want.uri;
    if (rawUri && rawUri.length > 0) {
      const parsed = parseConnectUrl(rawUri);
      if (parsed) {
        AppStorage.setOrCreate('pendingDeepLinkMode', parsed.mode);
        AppStorage.setOrCreate('pendingDeepLinkServer', parsed.serverUrl);
        AppStorage.setOrCreate('pendingDeepLinkDeviceId', parsed.deviceId);
        AppStorage.setOrCreate('pendingDeepLinkPin', parsed.pin);
      }
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    try {
      windowStage.getMainWindow().then((win: window.Window) => {
        WindowController.setMainWindow(win);
        win.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE);
      }).catch(() => {
        // Ignore if window keyboard avoid mode is unsupported
      });
    } catch {
      // Ignore
    }

    RecentStore.getInstance().init(this.context).finally(() => {
      windowStage.loadContent('pages/Index');
    });
  }

  onForeground(): void {
    AppStorage.setOrCreate('appForegroundTick', Date.now());
  }

  onBackground(): void {
    AppStorage.setOrCreate('appBackgroundTick', Date.now());
  }
}
