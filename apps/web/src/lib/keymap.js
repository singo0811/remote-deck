/**
 * Browser KeyboardEvent -> Windows Virtual Key (VK) mapper + mobile/tablet quick hotkeys.
 */
const CODE_TO_VK = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  NumpadEnter: 0x0d,
  ShiftLeft: 0x10,
  ShiftRight: 0x10,
  ControlLeft: 0x11,
  ControlRight: 0x11,
  AltLeft: 0x12,
  AltRight: 0x12,
  Pause: 0x13,
  CapsLock: 0x14,
  Escape: 0x1b,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  PrintScreen: 0x2c,
  Insert: 0x2d,
  Delete: 0x2e,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
  ContextMenu: 0x5d,
  Semicolon: 0xba,
  Equal: 0xbb,
  Comma: 0xbc,
  Minus: 0xbd,
  Period: 0xbe,
  Slash: 0xbf,
  Backquote: 0xc0,
  BracketLeft: 0xdb,
  Backslash: 0xdc,
  BracketRight: 0xdd,
  Quote: 0xde,
};

for (let i = 0; i < 26; i++) {
  CODE_TO_VK[`Key${String.fromCharCode(65 + i)}`] = 65 + i;
}
for (let i = 0; i <= 9; i++) {
  CODE_TO_VK[`Digit${i}`] = 48 + i;
  CODE_TO_VK[`Numpad${i}`] = 0x60 + i;
}
for (let i = 1; i <= 12; i++) {
  CODE_TO_VK[`F${i}`] = 0x6f + i;
}

export function eventToVk(e) {
  if (e.code && CODE_TO_VK[e.code]) {
    return CODE_TO_VK[e.code];
  }
  if (typeof e.keyCode === 'number' && e.keyCode > 0) {
    return e.keyCode;
  }
  return 0;
}

export const QUICK_HOTKEYS = [
  { id: 'esc', label: 'Esc', vk: 0x1b, mods: {} },
  { id: 'tab', label: 'Tab', vk: 0x09, mods: {} },
  { id: 'enter', label: 'Enter', vk: 0x0d, mods: {} },
  { id: 'backspace', label: '退格', vk: 0x08, mods: {} },
  { id: 'copy', label: 'Ctrl+C', vk: 67, mods: { ctrl: true } },
  { id: 'paste', label: 'Ctrl+V', vk: 86, mods: { ctrl: true } },
  { id: 'undo', label: 'Ctrl+Z', vk: 90, mods: { ctrl: true } },
  { id: 'selectall', label: 'Ctrl+A', vk: 65, mods: { ctrl: true } },
  { id: 'alttab', label: 'Alt+Tab', vk: 0x09, mods: { alt: true } },
  { id: 'win', label: 'Win', vk: 0x5b, mods: {} },
  { id: 'desktop', label: 'Win+D', vk: 68, mods: { meta: true } },
  { id: 'taskmgr', label: '任务管理', vk: 0x1b, mods: { ctrl: true, shift: true } },
];

export const VK_CODES = CODE_TO_VK;
