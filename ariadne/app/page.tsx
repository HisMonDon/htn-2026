"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";
import Galaxy from "@/components/Galaxy"; // Your React Bits component

export default function LandingPage() {
  const [message, setMessage] = useState("");
  const router = useRouter();

  const galaxyBackground = useMemo(
    () => (
      <div className="absolute inset-0 z-0 bg-black pointer-events-auto">
        <Galaxy
          starSpeed={0.5}
          density={1.5}
          glowIntensity={0.4}
          mouseInteraction={true}
          transparent={true}
        />
      </div>
    ),
    []
  );

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    
    // Transitions to the new UI
    router.push(`/tree?q=${encodeURIComponent(message)}`);
  };

  return (
    <main className="relative w-full h-screen overflow-hidden bg-black text-white font-sans">
      
      {/* Layer 1: The memoized interactive galaxy background */}
      {galaxyBackground}

      {/* Layer 2: UI Elements */}
      <div className="relative z-10 flex flex-col items-center justify-center w-full h-full px-4 pointer-events-none">
        
        {/* Title Elements */}
        <div className="flex flex-col items-center mb-10 space-y-4">
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight text-center bg-clip-text text-transparent bg-gradient-to-b from-white via-white to-gray-500 drop-shadow-2xl">
            Ariadne: Insert Subtitle
          </h1>
          
          <p className="text-lg md:text-xl text-gray-400 text-center max-w-lg mt-4">
            Insert Description
          </p>
        </div>

        {/* Chat Input Elements */}
        <div className="w-full max-w-2xl pointer-events-auto">
          <form
            onSubmit={handleSend}
            className="relative flex items-center w-full p-2 bg-white/5 backdrop-blur-xl border border-white/20 rounded-full shadow-2xl transition-all duration-300 focus-within:bg-white/10 focus-within:border-white/40 hover:bg-white/10 box-border"
          >
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Insert Placeholder"
              autoComplete="off"
              spellCheck="false"
              className="flex-1 px-6 py-4 bg-transparent text-white placeholder-gray-400 focus:outline-none focus:ring-0 text-lg"
            />
            <button
              type="submit"
              disabled={!message.trim()}
              className="p-4 rounded-full bg-white text-black hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-lg flex items-center justify-center group"
            >
              <Send 
                size={22} 
                className="ml-1 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" 
              />
            </button>
          </form>
        </div>

      </div>
    </main>
  );
}