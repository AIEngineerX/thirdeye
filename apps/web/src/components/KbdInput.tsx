"use client";

import { type ChangeEvent, type KeyboardEvent, type ReactNode, type Ref, forwardRef } from "react";

interface KbdInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  type?: "text" | "password";
  autoFocus?: boolean;
  /** Optional element rendered inside the right edge of the input. */
  trailing?: ReactNode;
  className?: string;
  "aria-label"?: string;
}

/**
 * Bare text input with mono font, hairline border, no rounded corners,
 * Enter-key submit. Replaces the entire shadcn Input surface area — fewer
 * dependencies, full control over the terminal aesthetic.
 */
function KbdInputInner(props: KbdInputProps, ref: Ref<HTMLInputElement>) {
  const {
    value,
    onChange,
    onSubmit,
    placeholder,
    type = "text",
    autoFocus,
    trailing,
    className,
  } = props;

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value);
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <label
      className={[
        "flex items-center gap-2 border border-border-emphasis bg-base px-3 py-2 transition-colors focus-within:border-accent",
        className ?? "",
      ].join(" ")}
    >
      <span aria-hidden="true" className="font-mono text-2xs text-accent">
        ▸
      </span>
      <input
        ref={ref}
        type={type}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        // biome-ignore lint/a11y/noAutofocus: keyboard-first daily-driver — landing input wants focus on mount
        autoFocus={autoFocus}
        aria-label={props["aria-label"]}
        className="flex-1 bg-transparent font-mono text-sm tabular text-primary placeholder:text-tertiary focus:outline-none"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
      />
      {trailing ? <span className="flex items-center">{trailing}</span> : null}
    </label>
  );
}

export const KbdInput = forwardRef<HTMLInputElement, KbdInputProps>(KbdInputInner);
