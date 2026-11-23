import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { MSG } from '../lib/protocol.js';

const QUICK_KEYS = [
  { label: 'Ctrl+C', seq: '\x03' },
  { label: 'Ctrl+D', seq: '\x04' },
  { label: 'Tab', seq: '\t' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: 'Esc', seq: '\x1b' },
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
];

const THEME = {
  background: '#060911',
  foreground: '#dbeafe',
  cursor: '#38bdf8',
  selectionBackground: 'rgba(56, 189, 248, 0.28)',
  black: '#0b1220',
  red: '#f87171',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e2e8f0',
  brightBlack: '#64748b',
  brightRed: '#fca5a5',
  brightGreen: '#6ee7b7',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
};

export function TerminalPanel({ tier, transport, ptyEventsRef, ptyTick }) {
  const [termId] = useState(() => `term-${Math.random().toString(36).slice(2, 8)}`);
  const [shell, setShell] = useState(() => (navigator.userAgent.includes('Win') ? 'powershell' : 'bash'));
  const [status, setStatus] = useState('closed');
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const lastSeqRef = useRef(0);
  const openedRef = useRef(false);
  const historyRef = useRef('');
  const transportRef = useRef(transport);
  const termIdRef = useRef(termId);

  transportRef.current = transport;
  termIdRef.current = termId;

  const sendRaw = (data) => {
    transportRef.current?.sendJson({ type: MSG.PTY_INPUT, id: termIdRef.current, data });
  };

  const fitNow = () => {
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    try {
      fit.fit();
      transportRef.current?.sendJson({
        type: MSG.PTY_RESIZE,
        id: termIdRef.current,
        cols: term.cols,
        rows: term.rows,
      });
    } catch {}
  };

  // Create the xterm instance once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      scrollback: 8000,
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
      fontSize: tier === 'phone' ? 11 : 12.5,
      lineHeight: 1.2,
      theme: THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    if (historyRef.current) {
      term.write(historyRef.current);
    }

    // All keystrokes (incl. arrows, Ctrl combos, IME-committed text) go straight to the PTY.
    term.onData((data) => sendRaw(data));
    term.onResize(() => {
      transportRef.current?.sendJson({
        type: MSG.PTY_RESIZE,
        id: termIdRef.current,
        cols: term.cols,
        rows: term.rows,
      });
    });

    const timer = setTimeout(() => {
      try {
        fit.fit();
      } catch {}
      term.focus();
    }, 60);

    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {}
      });
      ro.observe(host);
    }
    window.addEventListener('resize', fitNow);

    return () => {
      clearTimeout(timer);
      ro?.disconnect();
      window.removeEventListener('resize', fitNow);
      try {
        term.dispose();
      } catch {}
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier]);

  // Re-open the shell once the terminal exists.
  useEffect(() => {
    const term = termRef.current;
    if (!term || openedRef.current) return undefined;
    openedRef.current = true;
    setStatus('opening');
    transportRef.current?.sendJson({
      type: MSG.PTY_OPEN,
      id: termIdRef.current,
      shell,
      cols: term.cols || (tier === 'phone' ? 60 : 110),
      rows: term.rows || (tier === 'phone' ? 20 : 30),
    });
    return () => {
      transportRef.current?.sendJson({ type: MSG.PTY_CLOSE, id: termIdRef.current });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stream PTY output into the terminal emulator (full ANSI/VT support).
  useEffect(() => {
    const events = ptyEventsRef.current || [];
    const term = termRef.current;
    while (lastSeqRef.current < events.length) {
      const ev = events[lastSeqRef.current];
      lastSeqRef.current += 1;
      if (ev.id !== termIdRef.current) continue;
      if (ev.kind === 'opened') {
        setStatus(`running (${ev.mode || 'pty'})`);
      } else if (ev.kind === 'output') {
        historyRef.current += ev.text;
        if (historyRef.current.length > 200000) {
          historyRef.current = historyRef.current.slice(-120000);
        }
        term?.write(ev.text);
      } else if (ev.kind === 'exit') {
        setStatus(`exited (${ev.code ?? 0})`);
        term?.write(`\r\n\x1b[33m[进程已退出，退出码 ${ev.code ?? 0}]\x1b[0m\r\n`);
      }
    }
  }, [ptyTick, ptyEventsRef]);

  const restart = (targetShell = shell) => {
    const term = termRef.current;
    setStatus('opening');
    transportRef.current?.sendJson({ type: MSG.PTY_CLOSE, id: termIdRef.current });
    term?.reset();
    transportRef.current?.sendJson({
      type: MSG.PTY_OPEN,
      id: termIdRef.current,
      shell: targetShell,
      cols: term?.cols || 110,
      rows: term?.rows || 30,
    });
    term?.focus();
  };

  const tierBadge = tier === 'phone' ? 'phone' : tier;

  return (
    <div className={`terminal-panel tier-${tier}`}>
      <div className="panel-toolbar">
        <div className="panel-title">
          <strong>远程终端</strong>
          <span className="status-pill">{status}</span>
          <span className="term-tier-hint">{tierBadge}</span>
        </div>
        <div className="panel-controls">
          <select
            className="compact-select"
            value={shell}
            onChange={(e) => {
              setShell(e.target.value);
              restart(e.target.value);
            }}
          >
            <option value="powershell">PowerShell</option>
            <option value="cmd">CMD</option>
            <option value="pwsh">pwsh / sh</option>
            <option value="bash">bash</option>
          </select>
          <button type="button" className="btn-ghost" onClick={() => termRef.current?.reset()}>
            清屏
          </button>
          <button type="button" className="btn-secondary" onClick={() => restart(shell)}>
            重启
          </button>
        </div>
      </div>

      <div className="xterm-host" ref={hostRef} onClick={() => termRef.current?.focus()} />

      <div className="term-quick-strip">
        {QUICK_KEYS.map((item) => (
          <button
            key={item.label}
            type="button"
            className="vkey-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              sendRaw(item.seq);
              termRef.current?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
