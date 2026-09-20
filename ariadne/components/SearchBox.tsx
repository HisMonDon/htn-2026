"use client";

import React, { useRef, useState } from "react";
import { Search, TrendingUp, X } from "lucide-react";
import styles from "./SearchBox.module.css";

interface SearchBoxProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  disabled?: boolean;
}

const suggestions = [
  "memory-augmented potential field theory",
  "leveraging biometric leakage",
  "efficient llm uncertainty quantification",
  "binarized neural networks",
];

export default function SearchBox({
  value,
  onValueChange,
  onSubmit,
  disabled = false,
}: SearchBoxProps) {
  const [isFocused, setIsFocused] = useState(false);
  const glassRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const expanded = isFocused || value.length > 0;

  const updateValue = (nextValue: string) => {
    onValueChange(nextValue);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLFormElement>) => {
    const glass = glassRef.current;
    if (!glass) return;

    const rect = glass.getBoundingClientRect();
    glass.style.setProperty("--pointer-x", `${event.clientX - rect.left}px`);
    glass.style.setProperty("--pointer-y", `${event.clientY - rect.top}px`);
  };

  return (
    <div className={styles.root}>
      <form
        ref={glassRef}
        onSubmit={onSubmit}
        onPointerMove={handlePointerMove}
        className={`${styles.glass} ${expanded ? styles.expanded : ""}`}
      >
        <span className={styles.filter} aria-hidden="true" />
        <span className={styles.overlay} aria-hidden="true" />
        <span className={styles.specular} aria-hidden="true" />

        <div className={styles.content}>
          <div className={styles.searchRow}>
            <button
              type="submit"
              className={styles.searchButton}
              disabled={disabled || !value.trim()}
              aria-label="trace research"
            >
              <Search className={styles.searchIcon} strokeWidth={2.1} />
            </button>

            <input
              ref={inputRef}
              type="search"
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={(event) => {
                if (!glassRef.current?.contains(event.relatedTarget)) {
                  setIsFocused(false);
                }
              }}
              placeholder="Search..."
              autoComplete="off"
              spellCheck="false"
              disabled={disabled}
              aria-label="research topic"
              className={styles.input}
            />

            <button
              type="button"
              onClick={() => updateValue("")}
              disabled={disabled}
              className={`${styles.clearButton} ${value ? styles.clearVisible : ""}`}
              aria-label="clear search"
            >
              <X size={16.8} strokeWidth={1.8} />
            </button>
          </div>

          <div className={`${styles.suggestions} ${expanded ? styles.suggestionsActive : ""}`}>
            <h2>Suggestions</h2>
            <ul>
              {suggestions.map((suggestion) => (
                <li key={suggestion}>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => updateValue(suggestion)}
                    disabled={disabled}
                  >
                    <TrendingUp size={15} strokeWidth={1.9} aria-hidden="true" />
                    <span>{suggestion}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </form>
    </div>
  );
}
