import { useCallback, useEffect, useRef, type ReactNode } from "react";

// Shared Polaris web-component field bindings. Polaris fields under React 18 do NOT
// work via raw onInput/onChange/value props — bind native input/change events on the
// element via a ref and write the value back as a PROPERTY. See CLAUDE.md /
// [[polaris-web-components]]. (Onboarding has its own copies; consolidate later.)

type WcEl = HTMLElement & { value: string };

export function useWcField(
  value: string,
  onValueChange: (value: string) => void,
  onCommit?: (value: string) => void,
  format?: (raw: string) => string,
) {
  const elRef = useRef<WcEl | null>(null);
  const changeCb = useRef(onValueChange);
  const commitCb = useRef(onCommit);
  const fmtCb = useRef(format);
  changeCb.current = onValueChange;
  commitCb.current = onCommit;
  fmtCb.current = format;

  const handlers = useRef({
    input: (e: Event) => {
      const el = e.currentTarget as WcEl;
      const fmt = fmtCb.current;
      const next = fmt ? fmt(el.value) : el.value;
      if (fmt && el.value !== next) el.value = next;
      changeCb.current(next);
    },
    change: (e: Event) => {
      const el = e.currentTarget as WcEl;
      const fmt = fmtCb.current;
      const next = fmt ? fmt(el.value) : el.value;
      if (fmt && el.value !== next) el.value = next;
      changeCb.current(next);
      commitCb.current?.(next);
    },
  });

  const setRef = useCallback((el: HTMLElement | null) => {
    const prev = elRef.current;
    if (prev) {
      prev.removeEventListener("input", handlers.current.input);
      prev.removeEventListener("change", handlers.current.change);
    }
    elRef.current = el as WcEl | null;
    if (el) {
      el.addEventListener("input", handlers.current.input);
      el.addEventListener("change", handlers.current.change);
    }
  }, []);

  useEffect(() => {
    const el = elRef.current;
    if (el && el.value !== value) el.value = value;
  }, [value]);

  return setRef;
}

export function WcTextField({
  label,
  value,
  onValueChange,
  onCommit,
  format,
  placeholder,
  error,
  details,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  onCommit?: (value: string) => void;
  format?: (raw: string) => string;
  placeholder?: string;
  error?: string;
  details?: string;
}) {
  const ref = useWcField(value, onValueChange, onCommit, format);
  return (
    <s-text-field
      ref={ref}
      label={label}
      placeholder={placeholder}
      error={error}
      details={details}
    />
  );
}

export function WcSelect({
  label,
  value,
  onValueChange,
  details,
  placeholder,
  error,
  children,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  details?: string;
  placeholder?: string;
  error?: string;
  children: ReactNode;
}) {
  const ref = useWcField(value, onValueChange);
  return (
    <s-select
      ref={ref}
      label={label}
      details={details}
      placeholder={placeholder}
      error={error}
    >
      {children}
    </s-select>
  );
}
