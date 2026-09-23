"""
End-to-End Test for Enterprise 2-Legged BYO-MCP Integration.

Tests the full lifecycle:
1. Gemini Enterprise handshake (initialize / tools/list).
2. Direct unauthenticated tool call -> rejected with HTTP 401.
3. Agent Gateway ext_proc callout -> retrieves Google OIDC token from metadata server.
4. Authenticated tool call with injected token -> verified, exchanged via mock STS, executed with HTTP 200.
"""

import json
import sys
import requests
import grpc

try:
    from envoy.service.ext_proc.v3 import external_processor_pb2 as ep_pb2
    from envoy.service.ext_proc.v3 import external_processor_pb2_grpc as ep_grpc
    from envoy.config.core.v3 import base_pb2
except ImportError:
    print("Error: xds-protos or grpcio not installed. Use venv.")
    sys.exit(1)


PROXY_URL = "http://localhost:8080/mcp"
EXT_PROC_HOST = "localhost"
EXT_PROC_PORT = 50051


def test_mcp_initialize():
    print("\n[Step 1] Testing MCP Initialize handshake...")
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "gemini-enterprise-agent", "version": "1.0.0"}
        }
    }
    resp = requests.post(PROXY_URL, json=payload, headers={"Content-Type": "application/json"})
    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}"
    data = resp.json()
    print(f"  Response: {json.dumps(data, indent=2)}")
    assert data["result"]["serverInfo"]["name"] == "mock-enterprise-proxy"
    print("  MCP Initialize: PASSED")


def test_mcp_tools_list():
    print("\n[Step 2] Testing MCP tools/list...")
    payload = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    }
    resp = requests.post(PROXY_URL, json=payload, headers={"Content-Type": "application/json"})
    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}"
    data = resp.json()
    tools = data["result"]["tools"]
    print(f"  Discovered {len(tools)} tools: {[t['name'] for t in tools]}")
    assert any(t["name"] == "query_enterprise_portfolio" for t in tools)
    print("  MCP tools/list: PASSED")


def test_unauthenticated_tool_call():
    print("\n[Step 3] Testing direct unauthenticated tool call (Zero-Auth simulation)...")
    payload = {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "query_enterprise_portfolio",
            "arguments": {"desk": "equities-na"}
        }
    }
    resp = requests.post(PROXY_URL, json=payload, headers={"Content-Type": "application/json"})
    print(f"  Response Status: {resp.status_code}")
    print(f"  Response Body: {resp.text}")
    assert resp.status_code == 401, f"Expected 401 Unauthorized, got {resp.status_code}"
    print("  Zero-Auth rejection: PASSED (Enterprise proxy safely blocks unauthenticated requests)")


def get_token_via_ext_proc():
    print("\n[Step 4] Requesting Google OIDC Token via ext_proc service on port 50051...")
    channel = grpc.insecure_channel(f"{EXT_PROC_HOST}:{EXT_PROC_PORT}")
    stub = ep_grpc.ExternalProcessorStub(channel)

    request_headers = ep_pb2.HttpHeaders(
        headers=base_pb2.HeaderMap(
            headers=[
                base_pb2.HeaderValue(key=":method", value="POST"),
                base_pb2.HeaderValue(key=":authority", value="localhost:8080"),
                base_pb2.HeaderValue(key=":path", value="/mcp"),
                base_pb2.HeaderValue(key="content-type", value="application/json"),
            ]
        ),
        end_of_stream=False
    )
    req = ep_pb2.ProcessingRequest(request_headers=request_headers)

    def request_stream():
        yield req

    responses = stub.Process(request_stream())
    injected_auth_header = None
    for resp in responses:
        if resp.HasField("request_headers"):
            mutation = resp.request_headers.response.header_mutation
            for h in mutation.set_headers:
                if h.header.key.lower() == "authorization":
                    injected_auth_header = h.header.value or (h.header.raw_value.decode("utf-8") if h.header.raw_value else "")

    assert injected_auth_header is not None, "ext_proc failed to inject Authorization header"
    print(f"  ext_proc injected header: {injected_auth_header[:30]}...[TRUNCATED]")
    print("  ext_proc token acquisition: PASSED")
    return injected_auth_header


def test_authenticated_tool_call(auth_header):
    print("\n[Step 5] Testing authenticated tool call with injected Google OIDC token...")
    payload = {
        "jsonrpc": "2.0",
        "id": 5,
        "method": "tools/call",
        "params": {
            "name": "query_enterprise_portfolio",
            "arguments": {"desk": "equities-na", "asset_class": "equities"}
        }
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": auth_header,
    }
    resp = requests.post(PROXY_URL, json=payload, headers=headers)
    print(f"  Response Status: {resp.status_code}")
    assert resp.status_code == 200, f"Expected 200 OK, got {resp.status_code}"
    data = resp.json()
    result_text = data["result"]["content"][0]["text"]
    portfolio = json.loads(result_text)
    print("\n  Returned Portfolio Data:")
    print(f"    - Desk: {portfolio['desk']}")
    print(f"    - Authenticated Caller: {portfolio['authenticated_caller']}")
    print(f"    - Enterprise Internal Ticket: {portfolio['enterprise_internal_ticket']}")
    print(f"    - Net Market Value: {portfolio['metrics']['net_market_value']}")
    print(f"    - Daily PnL: {portfolio['metrics']['daily_pnl']}")
    print(f"    - Top Position: {portfolio['top_positions'][0]['symbol']} ({portfolio['top_positions'][0]['shares']} shares)")
    print("\n  Full End-to-End Flow: SUCCESS!")


if __name__ == "__main__":
    print("=================================================================")
    print("Enterprise 2-Legged MCP Architecture - End-to-End Verification Test")
    print("=================================================================")
    test_mcp_initialize()
    test_mcp_tools_list()
    test_unauthenticated_tool_call()
    auth_header = get_token_via_ext_proc()
    test_authenticated_tool_call(auth_header)
    print("\n=================================================================")
    print("All 5 test stages passed successfully!")
    print("=================================================================")
