import anthropic
import json
import os

UX_COPY_VARIANTS = {
    "numeric": "Privacy Score: 42/100 | Cameras passed: 7 | Cameras avoided: 4",
    "letter_grade": "Route Privacy: C+ | 7 cameras on this route (4 avoidable)",
    "plain_english": "This route passes 7 surveillance cameras. A privacy-optimized route exists that avoids 4 of them, adding 3 minutes.",
}

client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

results = {}
for variant_name, variant_text in UX_COPY_VARIANTS.items():
    scores = []
    for trial in range(3):
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=300,
            messages=[{
                "role": "user",
                "content": f"""You are a driver in a city. The navigation app shows: {variant_text}
Rate this message 1-5 on: (a) clarity, (b) actionability, (c) trust-building.
JSON response only: {{"clarity": N, "actionability": N, "trust": N, "total": N, "reasoning": "..."}}"""
            }]
        )
        text = response.content[0].text.strip()
        # parse JSON from response
        import re
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if match:
            score_data = json.loads(match.group())
            scores.append(score_data)
    
    avg_total = sum(s.get('total', s.get('clarity',0)+s.get('actionability',0)+s.get('trust',0)) for s in scores) / len(scores)
    results[variant_name] = {
        "variant_text": variant_text,
        "trials": scores,
        "avg_total": avg_total
    }

# Find winner
winner = max(results, key=lambda k: results[k]['avg_total'])
results["winner"] = winner
results["winner_text"] = UX_COPY_VARIANTS[winner]

print(json.dumps(results, indent=2))

# Save results
os.makedirs(os.path.expanduser("~/clawd/ghost-nav"), exist_ok=True)
with open(os.path.expanduser("~/clawd/ghost-nav/autoresearch_ux_copy_results.json"), "w") as f:
    json.dump(results, f, indent=2)

print(f"\nWINNER: {winner} (avg score: {results[winner]['avg_total']:.1f}/15)")
print(f"Text: {UX_COPY_VARIANTS[winner]}")
