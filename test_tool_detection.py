import json
import requests

payload = {
    "input": "What is the weather in Seattle today?",
    "metadata": {
        "agent_configs": {
            "DuckDuckGoSearchAgent": {
                "name": "DuckDuckGoSearchAgent",
                "instructions": "Please search the web for information.",
                "model_id": "llama3:8b"
            }
        },
        "orchestration_type": "concurrent"
    }
}

print("Sending test request to /v1/responses endpoint...")
print(f"Payload: {json.dumps(payload, indent=2)}\n")

try:
    response = requests.post(
        "http://127.0.0.1:8081/v1/responses",
        json=payload,
        stream=True,
        timeout=30
    )
    print(f"Status Code: {response.status_code}\n")
    print("Response stream (first 100 lines):")
    for i, line in enumerate(response.iter_lines()):
        if i >= 100:
            break
        if line:
            try:
                data = json.loads(line.decode('utf-8'))
                print(f"  Event type: {data.get('type')}")
                if data.get('type') == 'response.function_call.complete':
                    print(f"    ✓ TOOL CALL DETECTED: {data.get('function_call', {}).get('name')}")
                if data.get('delta'):
                    print(f"    Text: {data.get('delta')[:100]}")
            except:
                print(f"  {line.decode('utf-8')[:150]}")
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
