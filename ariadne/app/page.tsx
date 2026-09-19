"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Galaxy from "@/components/Galaxy";
import SpiralGalaxy from "@/components/SpiralGalaxy";
import SearchBox from "@/components/SearchBox";
import styles from "./landing.module.css";

export default function LandingPage() {
  const [message, setMessage] = useState("");
  const router = useRouter();

  const galaxyBackground = useMemo(
    () => (
      <div className={styles.galaxy}>
        <Galaxy
          focal={[0.5, 0.2625]}
          rotation={[1, 0]}
          starSpeed={0.315}
          density={1.05}
          hueShift={210}
          speed={0.7035}
          glowIntensity={0.525}
          saturation={0.475}
          mouseInteraction={true}
          mouseRepulsion={true}
          repulsionStrength={1.05}
          twinkleIntensity={0.42}
          rotationSpeed={0.095}
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
    <main className={styles.landing}>
      {galaxyBackground}
      <div className={styles.nebula} aria-hidden="true" />
      <SpiralGalaxy className={styles.spiralGalaxy} />
      <div className={styles.vignette} aria-hidden="true" />

      <div className={styles.content}>
        <header className={styles.header}>
          <h1 className={styles.title}>
            ariadne.
          </h1>

          <p className={styles.subhead}>
            trace every thread of research to its origin.
          </p>
        </header>

        <SearchBox
          value={message}
          onValueChange={setMessage}
          onSubmit={handleSend}
        />
      </div>
    </main>
  );
}
