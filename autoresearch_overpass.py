import requests, time, json

CHARLESTON_BBOX = "32.70,-80.10,32.90,-79.90"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

QUERY_VARIANTS = {
    "A_narrow_alpr": '[out:json]; node["surveillance:type"="ALPR"]({bbox}); out;',
    "B_broad_surveillance": '[out:json]; (node["man_made"="surveillance"]({bbox}); node["surveillance"="camera"]({bbox});); out;',
    "C_alpr_flock_genetec": '[out:json]; (node["surveillance:type"="ALPR"]({bbox}); node["operator"~"Flock",i]({bbox}); node["operator"~"Genetec",i]({bbox});); out;',
    "D_any_surveillance": '[out:json]; node["surveillance"]({bbox}); out;',
}

results = {}
for name, query_template in QUERY_VARIANTS.items():
    query = query_template.replace("{bbox}", CHARLESTON_BBOX)
    r = requests.post(OVERPASS_URL, data={"data": query}, timeout=30)
    nodes = r.json().get("elements", [])
    total = len(nodes)
    with_manufacturer = sum(1 for n in nodes if any(k in n.get("tags",{}) for k in ["manufacturer","brand","camera:type"]))
    with_direction = sum(1 for n in nodes if "direction" in n.get("tags",{}) or "camera:direction" in n.get("tags",{}))
    score = total * 0.5 + with_manufacturer * 0.3 + with_direction * 0.2
    results[name] = {"total_nodes": total, "nodes_with_manufacturer_tag": with_manufacturer, "nodes_with_direction_tag": with_direction, "score": score}
    print(f"{name}: {total} nodes, score={score:.2f}")
    time.sleep(2)

winner = max(results, key=lambda k: results[k]["score"])
results["winner"] = winner
results["summary"] = f"Best query: {winner} with score {results[winner]['score']:.2f} and {results[winner]['total_nodes']} nodes"

with open("/Users/michaelmartoccia/clawd/ghost-nav/autoresearch_overpass_results.json", "w") as f:
    json.dump(results, f, indent=2)
print(f"\nWinner: {winner}")
print(json.dumps(results, indent=2))
