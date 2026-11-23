import { RemoteClient } from '../protocol/RemoteClient';

interface QuickTermKey {
  label: string;
  seq: string;
}

const TERM_QUICK_KEYS: QuickTermKey[] = [
  { label: 'Ctrl+C', seq: '\x03' },
  { label: 'Tab', seq: '\t' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: '|', seq: '|' },
  { label: '/', seq: '/' },
  { label: '~', seq: '~' },
  { label: 'Esc', seq: '\x1b' },
];

/**
 * Minimal VT100 screen model: keeps a line buffer so carriage-return rewrites,
 * CSI K (erase line), CSI A/B (cursor up/down) and other progress-bar tricks
 * from vim / top / npm / docker actually render instead of piling up.
 */
export function stripAnsiChunk(currentText: string, incomingChunk: string): string {
  const lines: string[] = currentText.length > 0 ? currentText.split('\n') : [''];
  let row: number = lines.length - 1;
  let col: number = lines[row].length;

  const ensure = (): void => {
    while (lines.length <= row) {
      lines.push('');
    }
  };

  const put = (ch: string): void => {
    ensure();
    const line = lines[row];
    if (col < line.length) {
      lines[row] = line.slice(0, col) + ch + line.slice(col + 1);
    } else {
      lines[row] = line + ' '.repeat(Math.max(0, col - line.length)) + ch;
    }
    col += 1;
  };

  const paramNum = (raw: string, fallback: number): number => {
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? fallback : n;
  };

  const applyCsi = (params: string, cmd: string): void => {
    const first = params.split(';')[0];
    switch (cmd) {
      case 'A': {
        row = Math.max(0, row - paramNum(first, 1));
        ensure();
        col = Math.min(col, lines[row].length);
        break;
      }
      case 'B': {
        row = row + paramNum(first, 1);
        ensure();
        col = Math.min(col, lines[row].length);
        break;
      }
      case 'C': {
        col += paramNum(first, 1);
        break;
      }
      case 'D': {
        col = Math.max(0, col - paramNum(first, 1));
        break;
      }
      case 'K': {
        ensure();
        const mode = paramNum(first, 0);
        if (mode === 2) {
          lines[row] = '';
        } else if (mode === 0) {
          lines[row] = lines[row].slice(0, col);
        }
        break;
      }
      case 'J': {
        const mode = paramNum(first, 0);
        if (mode === 2 || mode === 3) {
          for (let k = 0; k < lines.length; k++) {
            lines[k] = '';
          }
          row = 0;
          col = 0;
        } else if (mode === 0) {
          ensure();
          lines[row] = lines[row].slice(0, col);
          if (lines.length > row + 1) {
            lines.splice(row + 1);
          }
        }
        break;
      }
      case 'H':
      case 'f': {
        const parts = params.split(';');
        row = Math.max(0, paramNum(parts[0], 1) - 1);
        col = Math.max(0, paramNum(parts.length > 1 ? parts[1] : '', 1) - 1);
        ensure();
        break;
      }
      default:
        break;
    }
  };

  let i = 0;
  while (i < incomingChunk.length) {
    const ch = incomingChunk[i];
    if (ch === '\x1b') {
      const next = incomingChunk[i + 1];
      if (next === ']') {
        const bel = incomingChunk.indexOf('\x07', i + 2);
        const st = incomingChunk.indexOf('\x1b\\', i + 2);
        if (bel !== -1 && (st === -1 || bel < st)) {
          i = bel + 1;
          continue;
        }
        if (st !== -1) {
          i = st + 2;
          continue;
        }
      }
      if (next === '[') {
        let j = i + 2;
        while (j < incomingChunk.length && !/[A-Za-z~]/.test(incomingChunk[j])) {
          j += 1;
        }
        applyCsi(incomingChunk.slice(i + 2, j), j < incomingChunk.length ? incomingChunk[j] : '');
        i = j + 1;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === '\n') {
      row += 1;
      col = 0;
      ensure();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      col = 0;
      i += 1;
      continue;
    }
    if (ch === '\b') {
      col = Math.max(0, col - 1);
      i += 1;
      continue;
    }
    if (ch === '\t') {
      col += 4 - (col % 4);
      i += 1;
      continue;
    }
    put(ch);
    i += 1;
  }

  let out = lines.join('\n');
  if (out.length > 120000) {
    out = out.slice(out.length - 90000);
  }
  return out;
}

@Component
export struct TerminalPane {
  @Prop tier: string = 'phone';
  @Prop termId: string = 'term-hm';
  @Prop termStatus: string = 'connecting';
  @Prop @Watch('onOutputChanged') output: string = '';
  client: RemoteClient | null = null;

  onRestartShell: (shell: string) => void = () => {};
  onClearOutput: () => void = () => {};

  @State shell: string = 'powershell';
  @State cmdLine: string = '';
  private scroller: Scroller = new Scroller();

  onOutputChanged(): void {
    setTimeout(() => {
      this.scroller.scrollEdge(Edge.Bottom);
    }, 30);
  }

  private sendCmd(): void {
    if (!this.client) return;
    this.client.sendPtyInput(this.termId, `${this.cmdLine}\r`);
    this.cmdLine = '';
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        Text('远程终端')
          .fontSize(14)
          .fontWeight(FontWeight.Bold)
          .fontColor('#E2E8F0')
        Text(this.termStatus)
          .fontSize(11)
          .fontColor('#34D399')
          .backgroundColor('#112D28')
          .padding({ left: 8, right: 8, top: 3, bottom: 3 })
          .borderRadius(10)

        Blank()

        Button(this.shell === 'powershell' ? 'PS' : 'CMD')
          .height(30)
          .fontSize(11)
          .backgroundColor('#1A2232')
          .fontColor('#38BDF8')
          .borderRadius(6)
          .onClick(() => {
            this.shell = this.shell === 'powershell' ? 'cmd' : 'powershell';
            this.onRestartShell(this.shell);
          })

        Button('清屏')
          .height(30)
          .fontSize(11)
          .backgroundColor('#1A2232')
          .fontColor('#94A3B8')
          .borderRadius(6)
          .onClick(() => {
            this.onClearOutput();
          })

        Button('重启')
          .height(30)
          .fontSize(11)
          .backgroundColor('#1A2232')
          .fontColor('#E2E8F0')
          .borderRadius(6)
          .onClick(() => {
            this.onRestartShell(this.shell);
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })
      .backgroundColor('#121824')
      .border({ width: { bottom: 1 }, color: '#253147' })

      Scroll(this.scroller) {
        Text(this.output.length > 0 ? this.output : '正在初始化远端伪终端...\n')
          .fontSize(this.tier === 'phone' ? 12 : 13)
          .fontFamily('monospace')
          .fontColor('#D1FAE5')
          .width('100%')
          .padding(12)
          .copyOption(CopyOptions.LocalDevice)
      }
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.TopStart)
      .backgroundColor('#06090F')

      Scroll() {
        Row({ space: 6 }) {
          ForEach(TERM_QUICK_KEYS, (item: QuickTermKey) => {
            Button(item.label)
              .height(30)
              .fontSize(11)
              .backgroundColor('#1A2232')
              .fontColor('#E2E8F0')
              .borderRadius(6)
              .onClick(() => {
                this.client?.sendPtyInput(this.termId, item.seq);
              })
          }, (item: QuickTermKey) => item.label)
        }
        .padding({ left: 10, right: 10, top: 6, bottom: 6 })
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%')
      .backgroundColor('#121824')
      .border({ width: { top: 1 }, color: '#253147' })

      Row({ space: 8 }) {
        Text('>')
          .fontSize(14)
          .fontColor('#38BDF8')
          .fontWeight(FontWeight.Bold)

        TextInput({
          text: this.cmdLine,
          placeholder: '输入命令后回车执行...',
        })
          .layoutWeight(1)
          .height(38)
          .fontSize(13)
          .fontColor('#E2E8F0')
          .placeholderColor('#64748B')
          .backgroundColor('#0B0F17')
          .borderRadius(8)
          .border({ width: 1, color: '#253147' })
          .onChange((val: string) => {
            this.cmdLine = val;
          })
          .onSubmit(() => {
            this.sendCmd();
          })

        Button('执行')
          .height(38)
          .fontSize(13)
          .backgroundColor('#38BDF8')
          .fontColor('#082F49')
          .borderRadius(8)
          .onClick(() => {
            this.sendCmd();
          })
      }
      .width('100%')
      .padding({ left: 10, right: 10, top: 6, bottom: 10 })
      .backgroundColor('#121824')
    }
    .width('100%')
    .height('100%')
  }
}
