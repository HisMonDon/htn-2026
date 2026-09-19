#fake backend

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import asyncio

app = FastAPI()

# Allow Next.js frontend to communicate with this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

async def simulate_browserbase_scrape(url: str):
    # TODO: Implement actual Browserbase Playwright script here.
    # We use asyncio.sleep to simulate web scraping time.
    await asyncio.sleep(2) 
    return {
        "text": "The James Webb Telescope discovered life on Mars...",
        "links": ["http://fake-news-site.com/mars", "http://another-site.com/aliens"]
    }

async def get_gptzero_score(text: str):
    # TODO: Implement real GPTZero API call here
    # requests.post("https://api.gptzero.me/v2/predict/text", ...)
    await asyncio.sleep(1)
    return 0.95 # Simulating a 95% probability of AI generation

async def extract_hallucinations(text: str):
    # TODO: Implement OpenAI/Claude extraction here
    await asyncio.sleep(1)
    return ["James Webb Telescope discovered life on Mars"]

@app.get("/api/trace")
async def trace_network(query: str):
    """
    This endpoint orchestrates the pipeline:
    1. Scrape -> 2. GPTZero -> 3. LLM Fact Check -> 4. Graph Formatting
    """
    
    # 1. Scrape the initial seed URL/Query
    scrape_data = await simulate_browserbase_scrape(query)
    
    # 2. Check AI Probability via GPTZero
    ai_score = await get_gptzero_score(scrape_data["text"])
    
    # 3. Extract hallucinations
    hallucinations = await extract_hallucinations(scrape_data["text"])

    # 4. In a production app, you would query Neo4j here.
    # For now, we construct the graph structure react-force-graph expects.
    
    nodes = []
    links = []

    # Add the primary article node
    nodes.append({
        "id": "node_seed",
        "title": f"Source: {query}",
        "type": "article",
        "aiScore": ai_score,
        "val": 20 # Size of node
    })

    # Add the hallucination node(s) and link them
    for i, h in enumerate(hallucinations):
        h_id = f"hallucination_{i}"
        nodes.append({
            "id": h_id,
            "title": f"Fake Claim: {h}",
            "type": "hallucination",
            "val": 15
        })
        # Link Article -> Hallucination
        links.append({"source": "node_seed", "target": h_id})

    # Add downstream articles (simulating the spread)
    for i, link in enumerate(scrape_data["links"]):
        child_id = f"child_article_{i}"
        nodes.append({
            "id": child_id,
            "title": f"Spread to: {link}",
            "type": "article",
            "aiScore": 0.88, # Assumed AI copied text
            "val": 10
        })
        # Link Downstream Article -> Same Hallucination
        links.append({"source": child_id, "target": f"hallucination_0"})

    return {
        "nodes": nodes,
        "links": links
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)