"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Galaxy from "@/components/Galaxy"; // Your React Bits component
import SearchBox from "@/components/SearchBox"; // Import the new component

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
    <main className="relative w-full h-screen overflow-hidden bg-black text-white font-sans lowercase">

      {/* Layer 1: The memoized interactive galaxy background */}
      {galaxyBackground}

      {/* Layer 2: UI Elements, anchored toward the bottom of the viewport */}
      <div className="relative z-10 flex flex-col items-center justify-end w-full h-full px-4 pb-[15vh] pointer-events-none">

        {/* Title Elements */}
        <div className="flex flex-col items-center mb-8">
          <h1 className="text-6xl md:text-8xl font-thin tracking-tight text-center text-white [text-shadow:0_0_35px_rgba(255,255,255,0.5)]">
            ariadne.
          </h1>

          <p
            className="italic text-lg md:text-xl text-white/80 text-center max-w-md mt-4 [text-shadow:0_0_20px_rgba(255,255,255,0.3)]"
            style={{ fontFamily: "var(--font-neuton)" }}
          >
            trace every thread of research to its origin.
          </p>
        </div>

        {/* Chat Input Component */}
        <SearchBox
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onSubmit={handleSend}
        />

      </div>
    </main>
  );
}