import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { TermLine } from '../lib/session';
import Icon, { NF } from './Icon';

interface Props {
  lines: TermLine[];
  prompt: string;
  masked: boolean;
  /** Return true to keep the typed text in the input (used for "?" help). */
  onSubmit: (line: string) => boolean | void;
  onTab: (line: string) => string | null;
  onClear: () => void;
  modeLabel: string;
}

export default function Terminal({ lines, prompt, masked, onSubmit, onTab, onClear, modeLabel }: Props) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, prompt]);

  function submit(line: string) {
    const keep = onSubmit(line);
    if (!masked && line.trim()) setHistory((h) => [...h.slice(-99), line]);
    setHistoryIndex(null);
    // "?" help leaves the partial command in place, like IOS re-printing it after the help text.
    setValue(keep ? line.replace(/\?$/, '') : '');
  }

  function onChange(next: string) {
    if (!masked && next.endsWith('?')) submit(next);
    else setValue(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(value);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const completed = onTab(value);
      if (completed) setValue(completed);
    } else if (e.key === '?' && !masked) {
      e.preventDefault();
      submit(value + '?');
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      onClear();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setValue(history[next]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === null) return;
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(null);
        setValue('');
      } else {
        setHistoryIndex(next);
        setValue(history[next]);
      }
    }
  }

  return (
    <div className="flex h-full flex-col bg-term font-mono text-[13px] leading-[1.45]" onClick={() => inputRef.current?.focus()}>
      <div ref={scrollRef} className="flex-1 overflow-auto px-4 py-3">
        {lines.map((l, i) =>
          l.kind === 'input' ? (
            <div key={i} className="whitespace-pre-wrap break-all">
              <span className="text-term-green">{l.prompt}</span>
              <span className="text-fg-bright">{l.text}</span>
            </div>
          ) : (
            <div key={i} className="whitespace-pre text-fg">
              {l.text || ' '}
            </div>
          ),
        )}
        <div className="flex whitespace-pre">
          <span className="text-term-green">{prompt}</span>
          <input
            ref={inputRef}
            type={masked ? 'password' : 'text'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Command input"
            placeholder={lines.length === 0 ? 'Type a command...' : ''}
            className="ml-0 flex-1 bg-transparent text-fg-bright caret-accent outline-none placeholder:text-muted"
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-surface px-4 py-1.5 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <Icon g={NF.terminal} className="text-accent" />
          <span className="label">{modeLabel}</span>
        </span>
        <span className="hidden gap-3 sm:flex">
          {[
            ['Tab', 'complete'],
            ['?', 'help'],
            ['↑↓', 'history'],
            ['Ctrl+L', 'clear'],
          ].map(([k, v]) => (
            <span key={k} className="whitespace-nowrap">
              <kbd className="rounded bg-surface-3 px-1 font-mono text-[10px] text-fg">{k}</kbd> {v}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
