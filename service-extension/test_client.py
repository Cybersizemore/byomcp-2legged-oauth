"""
Mock client to simulate Envoy ext_proc gRPC callout to Enterprise Token Injector.
"""
import grpc
import sys

try:
    from envoy.service.ext_proc.v3 import external_processor_pb2 as ep_pb2
    from envoy.service.ext_proc.v3 import external_processor_pb2_grpc as ep_grpc
    from envoy.config.core.v3 import base_pb2
except ImportError:
    print("Error: xds-protos or grpcio not installed in current Python env.")
    print("Run: pip install grpcio xds-protos")
    sys.exit(1)

def run_test(host="localhost", port=50051):
    channel = grpc.insecure_channel(f"{host}:{port}")
    stub = ep_grpc.ExternalProcessorStub(channel)

    print(f"Connecting to ext_proc service at {host}:{port}...")

    # Construct mock request headers simulating Gemini Enterprise tool call
    request_headers = ep_pb2.HttpHeaders(
        headers=base_pb2.HeaderMap(
            headers=[
                base_pb2.HeaderValue(key=":method", value="POST"),
                base_pb2.HeaderValue(key=":authority", value="enterprise-proxy.internal.run.app"),
                base_pb2.HeaderValue(key=":path", value="/mcp/tools/call"),
                base_pb2.HeaderValue(key="content-type", value="application/json"),
            ]
        ),
        end_of_stream=False
    )

    req = ep_pb2.ProcessingRequest(request_headers=request_headers)

    def request_stream():
        yield req

    print("\nSending mock request_headers to ext_proc...")
    responses = stub.Process(request_stream())

    for resp in responses:
        print("\n--- Received ProcessingResponse from ext_proc ---")
        if resp.HasField("request_headers"):
            rh = resp.request_headers
            mutation = rh.response.header_mutation
            print(f"Status: {rh.response.status}")
            print("\nInjected Headers:")
            for h in mutation.set_headers:
                val = h.header.value or (h.header.raw_value.decode('utf-8') if h.header.raw_value else "")
                # Truncate token for display
                display_val = val[:40] + "..." if len(val) > 40 else val
                print(f"  + {h.header.key}: {display_val}")

if __name__ == "__main__":
    host = sys.argv[1] if len(sys.argv) > 1 else "localhost"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 50051
    run_test(host, port)
