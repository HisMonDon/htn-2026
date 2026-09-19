/**
 * Reconstruct a lineage tree from a claim and print it.
 *
 *   USE_MOCKS=true npm run research               offline corpus (synthetic .test pages)
 *   npm run research                              live: direct HTTP fetch (resolver supplied by the host if needed)
 *   npm run research -- --claim "..." [--seed-url URL] [--cite "A v. B" --cite ...] [--json]
 *
 * Defaults to the falsehood claim of the Cohen/Bard seed case. Only the claim is used; the seed
 * case's recorded chain is never read.
 */
import fixture from "../../data/cohen-bard.json" with { type: "json" };
import type { LineageTree } from "../../shared/tree";
import { loadConfig } from "../config";
import { createDetector } from "../gptzero/client";
import { createResearchDeps } from "../research/factory";
import { runResearch } from "../research/pipeline";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function args(name: string): string[] {
  return process.argv.flatMap((value, index) => (value === name && process.argv[index + 1] ? [process.argv[index + 1]!] : []));
}

function printTree(tree: LineageTree) {
  const children = new Map<string, LineageTree["edges"]>();
  for (const edge of tree.edges) children.set(edge.parent_id, [...(children.get(edge.parent_id) ?? []), edge]);
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const label = (id: string) => {
    const node = nodes.get(id)!;
    const date = node.earliest_possible?.slice(0, 10) ?? "undated";
    return `${id}  [${node.publisher}, ${date}${node.timestamp_conflict ? ", DATE CONFLICT" : ""}]`;
  };
  const walk = (id: string, prefix: string) => {
    const kids = children.get(id) ?? [];
    kids.forEach((edge, index) => {
      const last = index === kids.length - 1;
      console.log(`${prefix}${last ? "└─" : "├─"} ${edge.confidence.toFixed(2)} ${edge.type.padEnd(11)} ${label(edge.child_id)}`);
      walk(edge.child_id, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  for (const root of tree.root_ids) {
    console.log(`ROOT ${label(root)}`);
    walk(root, "");
  }
}

const config = loadConfig();
const claim = arg("--claim") ?? fixture.falsehood.claim;
const cites = args("--cite");
const deps = createResearchDeps(config, createDetector(config));
console.log(`discovery: ${deps.search.kind}; retrieval: ${deps.index.kind}`);
console.log(`claim: ${claim}\n`);

const tree = await runResearch(
  {
    claim,
    seed_url: arg("--seed-url") ?? null,
    fabricated_citations: cites.length ? cites : undefined,
    include_ai_evidence: process.argv.includes("--ai"),
  },
  deps,
);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(tree, null, 2));
} else {
  console.log(`queries: ${tree.stats.queries.length}, fetched: ${tree.stats.fetched}, candidates: ${tree.stats.candidates}, pairs scored: ${tree.stats.pairs_scored}\n`);
  for (const failed of tree.stats.failed_queries) console.log(`failed query: ${failed}`);
  printTree(tree);
  console.log("\nexcluded:");
  for (const entry of tree.excluded) console.log(`  ${entry.id}: ${entry.reason}`);
  console.log("\naccepted edges:");
  for (const edge of tree.edges) {
    console.log(`  ${edge.parent_id} -> ${edge.child_id} (${edge.confidence})\n    ${edge.basis}`);
  }
}
