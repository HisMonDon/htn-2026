"use client";

import React from "react";
import { Send } from "lucide-react";

interface SearchBoxProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
}

export default function SearchBox({ value, onChange, onSubmit }: SearchBoxProps) {
  return (
    // Outer rectangular border element
    <div className="w-full max-w-2xl pointer-events-auto p-3 sm:p-4 bg-white/5 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-[0_0_40px_rgba(0,0,0,0.3)]">
      
      {/* Inner pill-shaped search box */}
      <form
        onSubmit={onSubmit}
        className="relative flex items-center w-full p-1.5 bg-black/40 border border-white/20 rounded-full transition-all duration-300 focus-within:bg-black/60 focus-within:border-white/40 hover:bg-black/50 box-border"
      >
        <input
          type="text"
          value={value}
          onChange={onChange}
          placeholder="What are you looking for?"
          autoComplete="off"
          spellCheck="false"
          className="flex-1 px-6 py-3 bg-transparent text-white placeholder-gray-400 focus:outline-none focus:ring-0 text-base sm:text-lg"
        />
        
        <button
          type="submit"
          disabled={!value.trim()}
          className="p-3 sm:p-4 rounded-full bg-white text-black hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-lg flex items-center justify-center group"
        >
          <Send
            size={20}
            className="ml-1 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform"
          />
        </button>
      </form>
      
    </div>
  );
}