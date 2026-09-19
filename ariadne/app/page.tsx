"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Galaxy from "@/components/Galaxy";
import SpiralGalaxy from "@/components/SpiralGalaxy";
import SearchBox from "@/components/SearchBox";
import styles from "./landing.module.css";

export default function LandingPage() {
  const [message, setMessage] = useState("");
  const [isTransitioning, setIsTransitioning] = useState(false);
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  useEffect(() => {
    router.prefetch("/tree");

    return () => {
      if (transitionTimer.current) clearTimeout(transitionTimer.current);
    };
  }, [router]);

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
    const query = message.trim();
    if (!query || isTransitioning) return;

    setIsTransitioning(true);

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    transitionTimer.current = setTimeout(
      () => router.push(`/tree?q=${encodeURIComponent(query)}`),
      prefersReducedMotion ? 240 : 1560
    );
  };

  return (
    <main
      className={`${styles.landing} ${isTransitioning ? styles.transitioning : ""}`}
      aria-busy={isTransitioning}
    >
      <div className={styles.scene} aria-hidden="true">
        {galaxyBackground}
        <div className={styles.nebula} />
        <SpiralGalaxy className={styles.spiralGalaxy} />
        <div className={styles.vignette} />
      </div>

      <div className={styles.content}>
        <header className={styles.header}>
          <h1 className={styles.title}>
            ariadne.
          </h1>

          <p className={styles.subhead}>
            trace every thread of research to pinpoint AI hallucinations.
          </p>
        </header>

        <SearchBox
          value={message}
          onValueChange={setMessage}
          onSubmit={handleSend}
          disabled={isTransitioning}
        />
      </div>

      <div className={styles.whiteout} aria-hidden="true" />
    </main>
  );
}
