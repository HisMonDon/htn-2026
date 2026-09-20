"use client";

import React, { useEffect, useState, Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Loader2, AlertTriangle, Route } from "lucide-react";
import { createResearch, type LineageTree } from "@/lib/api";
import { graphLegendItems, toGraphData, type GraphData, type GraphLegendItem } from "@/lib/graph";
import LiquidChrome from "@/components/LiquidChrome";
import AeroShards from "@/components/AeroShards";
import styles from "./tree.module.css";

const LEGEND_MARK_CLASS: Record<GraphLegendItem["mark"], string> = {
  seed: styles.legendSeed,
  candidate: styles.legendCandidate,
  validated: styles.legendValidated,
  conflict: styles.legendConflict,
  rejected: styles.legendRejected,
};

// DYNAMICALLY import the graph to prevent Next.js SSR crashes
const GraphVisualizer = dynamic(() => import("@/components/GraphVisualizer"), {
  ssr: false,
  loading: () => <p className={styles.stateText}>Unspooling the thread...</p>,
});

type Phase = "idle" | "researching" | "done" | "error";

type MockNode = Omit<LineageTree["nodes"][number], "source_kind">;
type MockEdge = Omit<LineageTree["edges"][number], "claim_mutations">;
type MockTree = Omit<LineageTree, "nodes" | "edges" | "status" | "diagnostics" | "stats"> & {
  nodes: MockNode[];
  edges: MockEdge[];
  stats: {
    discovery: "browserbase" | "offline-corpus";
    retrieval: "elastic-hybrid" | "elastic-lexical" | "memory-bm25";
    queries: string[];
    failed_queries: string[];
    fetched: number;
    candidates: number;
    pairs_scored: number;
  };
};

const MOCK_TREE_INPUT: MockTree = {
  seed: { claim: "New synthetic enzyme breaks down microplastics in under 24 hours.", url: null, fabricated_citations: [] },
  generated_at: new Date().toISOString(),
  root_ids: ["n1"],
  nodes: [
    // --- LEVEL 0 (Root) ---
    {
      id: "n1", canonical_id: "n1", content_fingerprint: "hash1",
      url: "https://nature-journal.example.com/enzymes/2023/11",
      mirror_urls: [], publisher: "Nature Synthetic Biology",
      title: "Rapid degradation of PET microplastics by engineered esterases",
      timestamp: "2023-11-01T10:00:00Z", timestamp_source: "json-ld", timestamp_confidence: "strong",
      earliest_possible: null, timestamp_conflict: null,
      passage: "We successfully engineered a novel thermophilic esterase that demonstrates near-complete degradation of PET microparticles within 24 hours at 40°C.",
      outbound_links: [], fabricated_citations: [], mutations: [], ai_evidence: null,
      discovered_via: ["browserbase"], is_seed: true,
    },
    // --- LEVEL 1 ---
    {
      id: "n2", canonical_id: "n2", content_fingerprint: "hash2",
      url: "https://techcrunch.example.com/2023/11/02/microplastic-enzyme",
      mirror_urls: [], publisher: "TechNews Daily",
      title: "Scientists invent enzyme that destroys microplastics in a day",
      timestamp: "2023-11-02T14:30:00Z", timestamp_source: "meta", timestamp_confidence: "strong",
      earliest_possible: "2023-11-01T10:00:00Z", timestamp_conflict: null,
      passage: "A new study published in Nature Synthetic Biology reveals an engineered enzyme capable of breaking down PET plastics in just 24 hours.",
      outbound_links: ["https://nature-journal.example.com/enzymes/2023/11"],
      fabricated_citations: [], mutations: ["Simplified scientific jargon", "Added sensational headline"],
      ai_evidence: null, discovered_via: ["elastic-hybrid"], is_seed: false,
    },
    {
      id: "n3", canonical_id: "n3", content_fingerprint: "hash3",
      url: "https://aifarm.example.net/health/plastic-cure",
      mirror_urls: [], publisher: "Daily Health Trends",
      title: "Miracle Enzyme CURES Plastic Pollution - What You Need To Know",
      timestamp: "2023-11-03T08:00:00Z", timestamp_source: "time-element", timestamp_confidence: "moderate",
      earliest_possible: "2023-11-01T10:00:00Z", timestamp_conflict: "Article says 'published today' but date is Nov 3.",
      passage: "In a groundbreaking discovery today, experts have found a miracle cure for ocean plastics. A thermophilic esterase can eat all plastic in 24 hours.",
      outbound_links: [], fabricated_citations: ["Smith, J. 'Ocean Plastics Cured', 2023"],
      mutations: ["Rewritten by AI", "Exaggerated claims (cures all plastic)"],
      ai_evidence: { provider: "gptzero", ai_probability: 0.99, label: "ai", checked_at: new Date().toISOString(), flagged_passages: ["In a groundbreaking discovery today, experts have found a miracle cure..."] },
      discovered_via: ["elastic-lexical"], is_seed: false,
    },
    {
      id: "n4", canonical_id: "n4", content_fingerprint: "hash4",
      url: "https://twitter.example.com/user/status/12345",
      mirror_urls: [], publisher: "X / Twitter",
      title: "Viral Thread on Microplastics",
      timestamp: "2023-11-02T18:15:00Z", timestamp_source: "url", timestamp_confidence: "strong",
      earliest_possible: null, timestamp_conflict: null,
      passage: "Holy crap. Researchers just dropped an enzyme that completely dissolves microplastics in 24 hours. Thread 🧵👇",
      outbound_links: ["https://nature-journal.example.com/enzymes/2023/11"],
      fabricated_citations: [], mutations: ["Converted to social media thread format"],
      ai_evidence: null, discovered_via: ["browserbase"], is_seed: false,
    },
    {
      id: "n13", canonical_id: "n13", content_fingerprint: "hash13",
      url: "https://hackernews.example.com/item?id=8888",
      mirror_urls: [], publisher: "Hacker News",
      title: "Rapid degradation of PET microplastics by engineered esterases (nature.com)",
      timestamp: "2023-11-01T11:45:00Z", timestamp_source: "search-result", timestamp_confidence: "strong",
      earliest_possible: null, timestamp_conflict: null,
      passage: "This looks huge for water treatment facilities. The 40C requirement is surprisingly low for this kind of catalytic efficiency.",
      outbound_links: ["https://nature-journal.example.com/enzymes/2023/11"],
      fabricated_citations: [], mutations: [], ai_evidence: null, discovered_via: ["browserbase"], is_seed: false,
    },
    // --- LEVEL 2 ---
    {
      id: "n5", canonical_id: "n5", content_fingerprint: "hash5",
      url: "https://eco-warriors.example.org/blog/enzyme",
      mirror_urls: [], publisher: "Eco Warriors Blog",
      title: "Big Plastic's Worst Nightmare Just Dropped",
      timestamp: "2023-11-04T12:00:00Z", timestamp_source: "json-ld", timestamp_confidence: "strong",
      earliest_possible: "2023-11-02T14:30:00Z", timestamp_conflict: null,
      passage: "As reported by TechNews, scientists invented an enzyme destroying plastics in a day. Why isn't the mainstream media talking about this?",
      outbound_links: ["https://techcrunch.example.com/2023/11/02/microplastic-enzyme"],
      fabricated_citations: [], mutations: ["Added conspiracy angle"],
      ai_evidence: null, discovered_via: ["elastic-hybrid"], is_seed: false,
    },
    {
      id: "n6", canonical_id: "n6", content_fingerprint: "hash6",
      url: "https://reddit.example.com/r/futurology/comments/abc",
      mirror_urls: [], publisher: "Reddit (r/Futurology)",
      title: "Scientists invent enzyme that destroys microplastics in a day",
      timestamp: "2023-11-02T15:00:00Z", timestamp_source: "search-result", timestamp_confidence: "strong",
      earliest_possible: null, timestamp_conflict: null,
      passage: "Link: TechNews Daily. Wow, if this scales it could clean up the Great Pacific Garbage Patch.",
      outbound_links: ["https://techcrunch.example.com/2023/11/02/microplastic-enzyme"],
      fabricated_citations: [], mutations: [], ai_evidence: null, discovered_via: ["browserbase"], is_seed: false,
    },
    {
      id: "n8", canonical_id: "n8", content_fingerprint: "hash8",
      url: "https://aggregator.bot.example.com/post/992",
      mirror_urls: [], publisher: "AutoNews Scraper",
      title: "Miracle Enzyme CURES Plastic Pollution",
      timestamp: "2023-11-03T08:05:00Z", timestamp_source: "meta", timestamp_confidence: "moderate",
      earliest_possible: "2023-11-03T08:00:00Z", timestamp_conflict: null,
      passage: "In a groundbreaking discovery today, experts have found a miracle cure for ocean plastics.",
      outbound_links: [], fabricated_citations: [], mutations: ["Truncated by scraper"],
      ai_evidence: null, discovered_via: ["elastic-lexical"], is_seed: false,
    },
    {
      id: "n11", canonical_id: "n11", content_fingerprint: "hash11",
      url: "https://tiktok.example.com/video/555",
      mirror_urls: [], publisher: "TikTok",
      title: "Plastic is OVER 🤯 #science",
      timestamp: "2023-11-04T19:00:00Z", timestamp_source: "meta", timestamp_confidence: "strong",
      earliest_possible: null, timestamp_conflict: null,
      passage: "Did you guys see that viral thread? Researchers dropped an enzyme that completely dissolves microplastics in 24 hours. We are saved.",
      outbound_links: [], fabricated_citations: [], mutations: ["Adapted into video script", "Omitted temperature caveats"],
      ai_evidence: null, discovered_via: ["browserbase"], is_seed: false,
    },
    {
      id: "n14", canonical_id: "n14", content_fingerprint: "hash14",
      url: "https://deepdive.example.com/biotech/esterase-analysis",
      mirror_urls: [], publisher: "BioTech Deep Dive",
      title: "Analyzing the new Nature esterase paper",
      timestamp: "2023-11-03T09:00:00Z", timestamp_source: "json-ld", timestamp_confidence: "strong",
      earliest_possible: "2023-11-01T11:45:00Z", timestamp_conflict: null,
      passage: "Following the discussion on HN, I ran some molecular dynamics simulations on the sequence provided in the supplementary material.",
      outbound_links: ["https://hackernews.example.com/item?id=8888", "https://nature-journal.example.com/enzymes/2023/11"],
      fabricated_citations: [], mutations: ["Original analysis added"], ai_evidence: null, discovered_via: ["elastic-hybrid"], is_seed: false,
    },
    // --- LEVEL 3 ---
    {
      id: "n7", canonical_id: "n7", content_fingerprint: "hash7",
      url: "https://facebook.example.com/groups/savetheocean/post",
      mirror_urls: [], publisher: "Facebook Groups",
      title: "Big Plastic's Worst Nightmare Just Dropped!!!",
      timestamp: "2023-11-05T07:30:00Z", timestamp_source: "time-element", timestamp_confidence: "weak",
      earliest_possible: null, timestamp_conflict: null,
      passage: "Read this blog post! As reported, scientists invented an enzyme destroying plastics in a day. SHARE before it's taken down!",
      outbound_links: ["https://eco-warriors.example.org/blog/enzyme"],
      fabricated_citations: [], mutations: ["Added urgent call to action"], ai_evidence: null, discovered_via: ["browserbase"], is_seed: false,
    },
    {
      id: "n9", canonical_id: "n9", content_fingerprint: "hash9",
      url: "https://ru-news.example.ru/science/plastic",
      mirror_urls: [], publisher: "RuNews Translate",
      title: "Чудо-фермент ИЗЛЕЧИВАЕТ пластиковое загрязнение",
      timestamp: "2023-11-04T10:00:00Z", timestamp_source: "meta", timestamp_confidence: "strong",
      earliest_possible: "2023-11-03T08:05:00Z", timestamp_conflict: null,
      passage: "Сегодня в ходе революционного открытия эксперты нашли чудодейственное лекарство от океанического пластика.",
      outbound_links: [], fabricated_citations: [], mutations: ["Machine translated to Russian"], ai_evidence: null, discovered_via: ["elastic-hybrid"], is_seed: false,
    },
    {
      id: "n12", canonical_id: "n12", content_fingerprint: "hash12",
      url: "https://buzzfeed.example.com/listicle/10-good-news",
      mirror_urls: [], publisher: "BuzzFeed News",
      title: "10 Good News Stories To Cure Your Doomscrolling",
      timestamp: "2023-11-06T14:00:00Z", timestamp_source: "meta", timestamp_confidence: "strong",
      earliest_possible: null, timestamp_conflict: null,
      passage: "Number 4: Plastic is OVER. TikTok users are going crazy over a new enzyme that dissolves microplastics.",
      outbound_links: ["https://tiktok.example.com/video/555"], fabricated_citations: [], mutations: ["Aggregated into listicle"], ai_evidence: null, discovered_via: ["elastic-lexical"], is_seed: false,
    },
    // --- LEVEL 4 ---
    {
      id: "n10", canonical_id: "n10", content_fingerprint: "hash10",
      url: "https://spam.example.net/chudo-ferment",
      mirror_urls: [], publisher: "SEO Spam Farm",
      title: "Купить Чудо-фермент ИЗЛЕЧИВАЕТ пластиковое загрязнение дешево",
      timestamp: "2023-11-05T22:00:00Z", timestamp_source: "none", timestamp_confidence: "none",
      earliest_possible: "2023-11-04T10:00:00Z", timestamp_conflict: null,
      passage: "Чудодейственное лекарство от океанического пластика купить сейчас со скидкой 50% нажмите здесь.",
      outbound_links: [], fabricated_citations: [], mutations: ["Commercialized spam text added", "Links replaced with affiliate links"], ai_evidence: null, discovered_via: ["elastic-lexical"], is_seed: false,
    },
    {
      id: "n15", canonical_id: "n15", content_fingerprint: "hash15",
      url: "https://instagram.example.com/p/123",
      mirror_urls: [], publisher: "Instagram",
      title: "Infographic: The Plastic Eating Enzyme",
      timestamp: "2023-11-05T09:00:00Z", timestamp_source: "meta", timestamp_confidence: "strong",
      earliest_possible: null, timestamp_conflict: null,
      passage: "Saw this on reddit r/Futurology: scientists invent enzyme that destroys microplastics in a day. Here's a breakdown of how it works.",
      outbound_links: ["https://reddit.example.com/r/futurology/comments/abc"], fabricated_citations: [], mutations: ["Converted to visual infographic format"], ai_evidence: null, discovered_via: ["browserbase"], is_seed: false,
    }
  ],
  edges: [
    // n1 children
    { parent_id: "n1", child_id: "n2", type: "propagation", confidence: 0.98, basis: "Direct explicit link and high text similarity.", shared_mutations: [], explicit_link: true, rare_shared_phrases: 4, similarity: 0.82, temporal: { parent_time: "2023-11-01T10:00:00Z", child_time: "2023-11-02T14:30:00Z", gap_days: 1, ordering: "strict" }, alternatives: [] },
    { parent_id: "n1", child_id: "n3", type: "similarity", confidence: 0.72, basis: "High semantic similarity to core claim despite lack of explicit citation.", shared_mutations: [], explicit_link: false, rare_shared_phrases: 0, similarity: 0.65, temporal: { parent_time: "2023-11-01T10:00:00Z", child_time: "2023-11-03T08:00:00Z", gap_days: 1, ordering: "strict" }, alternatives: [] },
    { parent_id: "n1", child_id: "n4", type: "propagation", confidence: 0.99, basis: "Direct external link to exact source.", shared_mutations: [], explicit_link: true, rare_shared_phrases: 1, similarity: 0.45, temporal: { parent_time: "2023-11-01T10:00:00Z", child_time: "2023-11-02T18:15:00Z", gap_days: 1, ordering: "strict" }, alternatives: [] },
    { parent_id: "n1", child_id: "n13", type: "propagation", confidence: 0.99, basis: "Direct domain link to exact article.", shared_mutations: [], explicit_link: true, rare_shared_phrases: 3, similarity: 0.95, temporal: { parent_time: "2023-11-01T10:00:00Z", child_time: "2023-11-01T11:45:00Z", gap_days: 0, ordering: "strict" }, alternatives: [] },
    // n2 children
    { parent_id: "n2", child_id: "n5", type: "propagation", confidence: 0.95, basis: "Direct link to TechNews article.", shared_mutations: ["Sensational headline phrasing"], explicit_link: true, rare_shared_phrases: 2, similarity: 0.78, temporal: { parent_time: "2023-11-02T14:30:00Z", child_time: "2023-11-04T12:00:00Z", gap_days: 1, ordering: "strict" }, alternatives: [] },
    { parent_id: "n2", child_id: "n6", type: "propagation", confidence: 0.96, basis: "Exact URL match in Reddit submission.", shared_mutations: ["Title matches parent verbatim"], explicit_link: true, rare_shared_phrases: 5, similarity: 0.99, temporal: { parent_time: "2023-11-02T14:30:00Z", child_time: "2023-11-02T15:00:00Z", gap_days: 0, ordering: "strict" }, alternatives: [] },
    // n3 children
    { parent_id: "n3", child_id: "n8", type: "similarity", confidence: 0.88, basis: "Automated scraping detected based on verbatim text copy.", shared_mutations: ["Rewritten by AI", "Exaggerated claims"], explicit_link: false, rare_shared_phrases: 6, similarity: 0.98, temporal: { parent_time: "2023-11-03T08:00:00Z", child_time: "2023-11-03T08:05:00Z", gap_days: 0, ordering: "strict" }, alternatives: [] },
    // n4 children
    { parent_id: "n4", child_id: "n11", type: "similarity", confidence: 0.85, basis: "Verbatim phrasing 'enzyme that completely dissolves microplastics in 24 hours'.", shared_mutations: ["Converted to social media thread format"], explicit_link: false, rare_shared_phrases: 4, similarity: 0.88, temporal: { parent_time: "2023-11-02T18:15:00Z", child_time: "2023-11-04T19:00:00Z", gap_days: 2, ordering: "strict" }, alternatives: [{ candidate_id: "n1", confidence: 0.3, reason: "Lacks the specific viral social phrasing present in n4." }] },
    // n5 children
    { parent_id: "n5", child_id: "n7", type: "propagation", confidence: 0.94, basis: "Direct explicit share link.", shared_mutations: ["Conspiracy angle", "Sensational headline phrasing"], explicit_link: true, rare_shared_phrases: 3, similarity: 0.85, temporal: { parent_time: "2023-11-04T12:00:00Z", child_time: "2023-11-05T07:30:00Z", gap_days: 0, ordering: "strict" }, alternatives: [] },
    // n6 children
    { parent_id: "n6", child_id: "n15", type: "propagation", confidence: 0.89, basis: "Explicit textual reference to specific Reddit thread.", shared_mutations: [], explicit_link: true, rare_shared_phrases: 1, similarity: 0.45, temporal: { parent_time: "2023-11-02T15:00:00Z", child_time: "2023-11-05T09:00:00Z", gap_days: 2, ordering: "strict" }, alternatives: [] },
    // n8 children
    { parent_id: "n8", child_id: "n9", type: "similarity", confidence: 0.76, basis: "Cross-lingual semantic match of specific scraped phrasing.", shared_mutations: ["Exaggerated claims"], explicit_link: false, rare_shared_phrases: 0, similarity: 0.70, temporal: { parent_time: "2023-11-03T08:05:00Z", child_time: "2023-11-04T10:00:00Z", gap_days: 1, ordering: "strict" }, alternatives: [] },
    // n9 children
    { parent_id: "n9", child_id: "n10", type: "similarity", confidence: 0.92, basis: "Exact match of Russian translated text.", shared_mutations: ["Machine translated to Russian"], explicit_link: false, rare_shared_phrases: 5, similarity: 0.85, temporal: { parent_time: "2023-11-04T10:00:00Z", child_time: "2023-11-05T22:00:00Z", gap_days: 1, ordering: "strict" }, alternatives: [] },
    // n11 children
    { parent_id: "n11", child_id: "n12", type: "propagation", confidence: 0.95, basis: "Embedded TikTok video in listicle.", shared_mutations: ["Omitted temperature caveats"], explicit_link: true, rare_shared_phrases: 1, similarity: 0.40, temporal: { parent_time: "2023-11-04T19:00:00Z", child_time: "2023-11-06T14:00:00Z", gap_days: 1, ordering: "strict" }, alternatives: [] },
    // n13 children
    { parent_id: "n13", child_id: "n14", type: "propagation", confidence: 0.91, basis: "Explicit link back to HN discussion.", shared_mutations: [], explicit_link: true, rare_shared_phrases: 1, similarity: 0.35, temporal: { parent_time: "2023-11-01T11:45:00Z", child_time: "2023-11-03T09:00:00Z", gap_days: 1, ordering: "strict" }, alternatives: [] },
  ],
  rejected_edges: [
    { parent_id: "n4", child_id: "n2", confidence: 0.15, reason: "Temporal inversion: child was published before parent despite similarity." },
    { parent_id: "n6", child_id: "n3", confidence: 0.22, reason: "Weak semantic similarity and differing mutation paths." }
  ],
  excluded: [
    { id: "exc1", url: "https://spam.example.com/unrelated", reason: "Below relevance threshold (0.12)" }
  ],
  stats: {
    discovery: "browserbase", retrieval: "elastic-hybrid", queries: ["New synthetic enzyme microplastics 24 hours"], failed_queries: [], fetched: 45, candidates: 16, pairs_scored: 54,
  },
};

const MOCK_TREE: LineageTree = {
  ...MOCK_TREE_INPUT,
  nodes: MOCK_TREE_INPUT.nodes.map((node) => ({ ...node, source_kind: "fetched" })),
  edges: MOCK_TREE_INPUT.edges.map((edge) => ({ ...edge, claim_mutations: [] })),
  status: "complete",
  diagnostics: [],
  stats: {
    pipeline: "recursive-provenance",
    max_depth: 5,
    sources_expanded: MOCK_TREE_INPUT.stats.candidates,
    proposals_received: MOCK_TREE_INPUT.stats.pairs_scored,
    fetched: MOCK_TREE_INPUT.stats.fetched,
    fetch_failures: 0,
    analysis_requests: MOCK_TREE_INPUT.stats.candidates,
  },
};

function TreeView() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q"); // The claim typed on the landing page

  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [researchId, setResearchId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Initializing Ariadne Protocol...");
  const [isMock, setIsMock] = useState(false);

  useEffect(() => {
    if (!query) return; // stays "idle"; the render guards on `query` too

    const controller = new AbortController();
    // Status updates so the wait reads as progress; the backend runs as one request.
    const timers = [
      setTimeout(() => setStatus("Deploying research spiders..."), 2000),
      setTimeout(() => setStatus("Scoring candidate parents..."), 5000),
      setTimeout(() => setStatus("Reconstructing propagation tree..."), 8000),
    ];

    const run = async () => {
      setPhase("researching");
      setError(null);
      setIsMock(false);
      setStatus("Initializing Ariadne Protocol...");
      try {
        const result = await createResearch(query, { signal: controller.signal });
        setResearchId(result.id);
        setGraphData(toGraphData(result.tree, result.edges, result.nodes));
        setPhase("done");
      } catch (err) {
        if (controller.signal.aborted) return;
        console.warn("Research request failed, falling back to mock mode:", err);
        
        // Inject the actual user query into the mock so it looks cohesive
        const localizedMockTree = {
          ...MOCK_TREE,
          seed: { ...MOCK_TREE.seed, claim: query },
        };
        
        setIsMock(true);
        setResearchId("mock-" + Math.random().toString(36).substring(2, 10));
        setGraphData(toGraphData(localizedMockTree));
        setPhase("done");
      }
    };

    run();

    return () => {
      controller.abort();
      timers.forEach(clearTimeout);
    };
  }, [query]);

  const liquidchromebg = useMemo(
    () => (
      <LiquidChrome
          baseColor={[0.1, 0.1, 0.1]}
          speed={0.2}
          amplitude={0.3}
          frequencyX={3}
          frequencyY={3}
          interactive={false}
        />
    ),
    []
  );

  return (
    <main className={styles.workspace}>
      {liquidchromebg}
      <div className="absolute inset-0 pointer-events-none bg-black/35" aria-hidden="true" />

      <header className={styles.header}>
        <div className={styles.brand}>
          <div className={styles.brandMark}>
            <Route size={19} strokeWidth={1.45} />
          </div>
          <div>
            <p className={styles.eyebrow}>Provenance map</p>
            <h1 className={styles.title}>
              ariadne <span>/ trace</span>
            </h1>
          </div>
        </div>
        <div className={styles.target}>
          <span className={styles.targetLabel}>Following</span>
          <span>{query ?? "No claim selected"}</span>
          {researchId && <span className={styles.targetId}>#{researchId.slice(0, 8)}</span>}
        </div>
      </header>

      {/* Role legend - provenance roles, not a truth classification. */}
      {query && phase === "done" && graphData && (
        <div className={styles.legend}>
          {graphLegendItems(graphData).map(({ label, mark }) => (
            <span key={label} className="flex items-center gap-2">
              <span className={`${styles.legendMark} ${LEGEND_MARK_CLASS[mark]}`} />
              {label}
            </span>
          ))}
        </div>
      )}

      {/* Mock Mode Alert */}
      {isMock && phase === "done" && (
        <div className="absolute top-[5.65rem] left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full border border-[#d5ad61]/30 bg-[#25180c]/80 px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[#d5ad61] shadow-2xl backdrop-blur-xl">
          <AlertTriangle size={14} />
          Live API unreachable — displaying sample graph
        </div>
      )}

      {!query && (
        <div className={styles.stateCard}>
          <div className={styles.stateIcon}><Route size={27} strokeWidth={1.3} /></div>
          <p className={styles.stateText}>No thread to follow yet.</p>
          <p className={styles.stateMeta}>Start from the home page and give Ariadne a claim to trace.</p>
        </div>
      )}

      {query && phase !== "done" && phase !== "error" && (
        <div className={styles.stateCard}>
          <div className={styles.stateIcon}>
            <Loader2 className="animate-spin" size={27} strokeWidth={1.35} />
          </div>
          <p className={styles.stateText}>{status}</p>
          <p className={styles.stateMeta}>Searching for sources, dates, and the relationships between them.</p>
        </div>
      )}

      {query && phase === "error" && !isMock && (
        <div className={styles.stateCard}>
          <div className={styles.stateIcon}><AlertTriangle size={27} strokeWidth={1.35} /></div>
          <p className={styles.stateText}>The thread broke before the map was complete.</p>
          <p className={styles.stateMeta}>{error}</p>
        </div>
      )}

      {/* Graph Render */}
      {query && phase === "done" && graphData && (
        <div className={styles.graphRegion}>
          <GraphVisualizer data={graphData} />
        </div>
      )}
    </main>
  );
}

export default function TreePage() {
  return (
    <Suspense
      fallback={
        <main className={styles.workspace}>
          <LiquidChrome
            baseColor={[0.1, 0.1, 0.1]}
            speed={0.2}
            amplitude={0.3}
            frequencyX={3}
            frequencyY={3}
            interactive={false}
          />
          <div className="absolute inset-0 pointer-events-none bg-black/35" aria-hidden="true" />
          <div className={styles.stateCard}>
            <div className={styles.stateIcon}><Loader2 className="animate-spin" size={27} /></div>
          </div>
        </main>
      }
    >
      <TreeView />
    </Suspense>
  );
}
