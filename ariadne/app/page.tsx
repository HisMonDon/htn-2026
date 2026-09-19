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
    <main className="relative w-full h-screen overflow-hidden bg-black text-white font-sans">
      
      {/* Layer 1: The memoized interactive galaxy background */}
      {galaxyBackground}

      {/* Layer 2: UI Elements */}
      <div className="relative z-10 flex flex-col items-center justify-center w-full h-full px-4 pointer-events-none">
        
        {/* Title Elements */}
        <div className="flex flex-col items-center mb-10 space-y-4">
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight text-center bg-clip-text text-transparent bg-gradient-to-b from-white via-white to-gray-500 drop-shadow-2xl">
            Ariadne
          </h1>
          
          <p className="text-lg md:text-xl text-gray-400 text-center max-w-lg mt-4">
            Insert Description
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