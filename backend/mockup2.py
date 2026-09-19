import os
import asyncio
import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import hashlib

from dotenv import load_dotenv
load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allow frontend connection
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------
# 1. THE SCRAPER (MOCKED FOR NOW)
# ---------------------------------------------------------
async def run_browserbase_scrape(url: str, current_depth: int, max_depth: int):
    """
    MOCKED FUNCTION: Returns text that reads like AI to trigger GPTZero.
    Generates fake outbound links to build the network tree.
    """
    await asyncio.sleep(1) # Simulate scraping delay
    
    # Text designed to sound like AI-generated misinformation
    mock_text = (
        f"This is an automated report from {url}. In a shocking discovery today, "
        "NASA confirmed that the Moon is actually composed entirely of aged cheddar cheese. "
        "Furthermore, recently declassified documents prove that the internet was invented "
        "by the Ancient Egyptians in 3000 BC."
    )
    
    # Generate fake spread if we haven't hit the depth limit
    outbound_links = []
    if current_depth < max_depth:
        base_domain = url.split("://")[-1].split("/")[0]
        outbound_links = [
            f"https://{base_domain}/related-post-{current_depth}-A",
            f"https://{base_domain}/related-post-{current_depth}-B"
        ]
        
    return {
        "text": mock_text,
        "links": outbound_links,
        "title": f"Article ({url.split('//')[-1][:15]}...)"
    }

# ---------------------------------------------------------
# 2. AI ANALYSIS PIPELINE (GPTZero ONLY)
# ---------------------------------------------------------
async def analyze_with_gptzero(text: str):
    """
    Calls GPTZero v2 API. 
    Returns: (document_ai_score, list_of_ai_claims)
    """
    api_key = os.getenv("GPTZERO_API_KEY", "")
    
    # Fallback if no API key is provided during local testing
    if not api_key:
        print("Warning: No GPTZero API Key found. Returning mock scores.")
        return 0.85, ["NASA confirmed that the Moon is actually composed entirely of aged cheddar cheese."]

    url = "https://api.gptzero.me/v2/predict/text"
    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json"
    }
    payload = {"document": text}
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(url, headers=headers, json=payload, timeout=15.0)
            response.raise_for_status()
            data = response.json()
            
            doc = data["documents"][0]
            doc_score = doc["completely_generated_prob"]
            
            # Extract specific sentences flagged as AI
            ai_sentences = []
            if "sentences" in doc:
                # Filter sentences that have a high probability of being AI (> 70%)
                highly_likely_ai = [s for s in doc["sentences"] if s.get("generated_prob", 0) > 0.7]
                
                # Sort by highest probability first
                highly_likely_ai.sort(key=lambda x: x.get("generated_prob", 0), reverse=True)
                
                # Take the top 3 sentences to act as our "extracted claims" 
                # (Keeps the graph readable)
                ai_sentences = [s["sentence"] for s in highly_likely_ai[:3]]
                
            return doc_score, ai_sentences

        except Exception as e:
            print(f"GPTZero Error: {e}")
            return 0.0, []

# ---------------------------------------------------------
# 3. RECURSIVE NETWORK TRACING
# ---------------------------------------------------------
@app.get("/api/trace")
async def trace_network(query: str, max_depth: int = 2):
    if not query.startswith("http"):
        query = "https://" + query

    # Global state for traversing the tree
    visited_urls = set()
    nodes_dict = {} # Deduplicate nodes by ID
    links = []

    async def traverse(url: str, current_depth: int):
        if current_depth > max_depth or url in visited_urls:
            return
        
        visited_urls.add(url)
        print(f"[{current_depth}/{max_depth}] Scraping & Evaluating: {url}")

        # 1. Scrape
        scrape_data = await run_browserbase_scrape(url, current_depth, max_depth)
        
        # 2. Evaluate with GPTZero (Gets both Score and Extracted AI Claims in ONE call)
        ai_score, claims = await analyze_with_gptzero(scrape_data["text"])

        # 3. Add the Article Node
        nodes_dict[url] = {
            "id": url,
            "title": scrape_data["title"],
            "type": "article",
            "aiScore": ai_score,
            "val": 20 if current_depth == 0 else 10
        }

        # 4. Add Claim Nodes and link Article -> Claim
        for claim in claims:
            # Create a unique, deterministic ID for the claim using its text
            # This ensures if two articles share the exact same fake claim, they link to the SAME node!
            claim_id = "claim_" + hashlib.md5(claim.encode()).hexdigest()[:8]
            
            if claim_id not in nodes_dict:
                nodes_dict[claim_id] = {
                    "id": claim_id,
                    "title": f"AI Claim: {claim[:40]}...", # Truncate long sentences for graph readability
                    "full_text": claim,
                    "type": "hallucination",
                    "val": 15
                }
            
            # Connect the article to the extracted claim
            links.append({"source": url, "target": claim_id})

        # 5. Recurse through outbound links
        for next_url in scrape_data["links"]:
            # Connect the parent Article to the child Article it links to
            links.append({"source": url, "target": next_url})
            
            # Traverse deeper into the child link
            await traverse(next_url, current_depth + 1)

    # Start the recursive engine
    await traverse(query, current_depth=0)

    return {
        "nodes": list(nodes_dict.values()),
        "links": links
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)