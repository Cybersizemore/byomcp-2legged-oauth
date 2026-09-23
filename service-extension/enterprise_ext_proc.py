"""
Enterprise 2-Legged MCP Authentication Service Extension (ext_proc) for Agent Gateway.
Intercepts outbound Gemini Enterprise 'No-Auth' tool calls and dynamically injects:
1. Google Cloud OIDC ID Token minted for a Customer-Managed Service Account (CMSA).
2. Sets Authorization: Bearer <Google_OIDC_Token> and x-serverless-authorization.
3. Cleanses sensitive session headers on reverse path back to Gemini Enterprise.
"""

import os
import sys
import logging
import concurrent.futures
import urllib.request
import urllib.error
import grpc
from typing import Dict, List, Tuple

from envoy.service.ext_proc.v3 import external_processor_pb2 as ep_pb2
from envoy.service.ext_proc.v3 import external_processor_pb2_grpc as ep_grpc
from envoy.config.core.v3 import base_pb2

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [enterprise_ext_proc] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("enterprise_ext_proc")

PORT = int(os.environ.get("PORT", "50051"))
TARGET_AUDIENCE_OVERRIDE = os.environ.get("TARGET_AUDIENCE", "")

def get_metadata_oidc_token(audience: str) -> str:
    """
    Fetches a Google-signed OIDC ID Token from the local Compute Metadata server.
    This token is cryptographically signed by accounts.google.com and bound to the target audience.
    """
    url = (
        "http://metadata.google.internal/computeMetadata/v1/instance/"
        f"service-accounts/default/identity?audience={audience}&format=full"
    )
    req = urllib.request.Request(url, headers={"Metadata-Flavor": "Google"})
    try:
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            token = resp.read().decode("utf-8").strip()
            logger.info("Successfully minted Google OIDC token from metadata service (aud=%s)", audience)
            return token
    except urllib.error.URLError as e:
        logger.error("Failed to fetch OIDC token from metadata service: %s", e)
        return ""
    except Exception as e:
        logger.error("Unexpected error fetching token: %s", e)
        return ""

class EnterpriseTokenInjector(ep_grpc.ExternalProcessorServicer):
    """Envoy ext_proc gRPC implementation for Agent Gateway."""

    def __init__(self):
        super().__init__()
        logger.info("EnterpriseTokenInjector initialized on port %s", PORT)

    def _extract_headers(self, headers_msg: ep_pb2.HttpHeaders) -> Dict[str, str]:
        headers_dict = {}
        for h in headers_msg.headers.headers:
            key = h.key.lower()
            val = h.value
            if not val and h.raw_value:
                try:
                    val = h.raw_value.decode("utf-8", errors="replace")
                except Exception:
                    val = str(h.raw_value)
            headers_dict[key] = val
        return headers_dict

    def Process(self, request_iterator, context):
        for request in request_iterator:
            req_type = request.WhichOneof("request")
            response = ep_pb2.ProcessingResponse()

            # ------------------------------------------------------------------
            # 1. PROCESS REQUEST HEADERS (Outbound Injection)
            # ------------------------------------------------------------------
            if req_type == "request_headers":
                headers = self._extract_headers(request.request_headers)
                authority = headers.get(":authority", headers.get("host", ""))
                path = headers.get(":path", "/")

                logger.info("Intercepted outbound call from Gemini Enterprise -> %s%s", authority, path)

                # Determine target audience for Enterprise proxy
                target_aud = TARGET_AUDIENCE_OVERRIDE or f"https://{authority}"

                # 1. Mint Google OIDC token dynamically from Metadata Server
                oidc_token = get_metadata_oidc_token(target_aud)

                header_mutation = ep_pb2.HeaderMutation()

                if oidc_token:
                    # Injected standard Bearer token
                    header_mutation.set_headers.append(
                        base_pb2.HeaderValueOption(
                            header=base_pb2.HeaderValue(
                                key="authorization",
                                value=f"Bearer {oidc_token}"
                            ),
                            append_action=base_pb2.HeaderValueOption.OVERWRITE_IF_EXISTS_OR_ADD
                        )
                    )
                    # Add Cloud Run IAM header for Cloud Run proxy backends
                    header_mutation.set_headers.append(
                        base_pb2.HeaderValueOption(
                            header=base_pb2.HeaderValue(
                                key="x-serverless-authorization",
                                value=f"Bearer {oidc_token}"
                            ),
                            append_action=base_pb2.HeaderValueOption.OVERWRITE_IF_EXISTS_OR_ADD
                        )
                    )

                # Metadata tracking headers
                header_mutation.set_headers.append(
                    base_pb2.HeaderValueOption(
                        header=base_pb2.HeaderValue(
                            key="x-injected-by",
                            value="agent-gateway-enterprise-extproc"
                        ),
                        append_action=base_pb2.HeaderValueOption.OVERWRITE_IF_EXISTS_OR_ADD
                    )
                )

                response.request_headers.response.header_mutation.CopyFrom(header_mutation)
                response.request_headers.response.status = ep_pb2.CommonResponse.ResponseStatus.CONTINUE
                yield response

            # ------------------------------------------------------------------
            # 2. PROCESS RESPONSE HEADERS (Reverse Path Sanitization)
            # ------------------------------------------------------------------
            elif req_type == "response_headers":
                logger.info("Sanitizing response headers returning to Gemini Enterprise")
                header_mutation = ep_pb2.HeaderMutation()
                header_mutation.remove_headers.extend([
                    "set-cookie",
                    "www-authenticate",
                    "x-serverless-authorization",
                    "authorization",
                ])
                response.response_headers.response.header_mutation.CopyFrom(header_mutation)
                response.response_headers.response.status = ep_pb2.CommonResponse.ResponseStatus.CONTINUE
                yield response

            # ------------------------------------------------------------------
            # 3. REQUEST / RESPONSE BODY (Pass-Through)
            # ------------------------------------------------------------------
            elif req_type == "request_body":
                response.request_body.response.status = ep_pb2.CommonResponse.ResponseStatus.CONTINUE
                yield response

            elif req_type == "response_body":
                response.response_body.response.status = ep_pb2.CommonResponse.ResponseStatus.CONTINUE
                yield response

            else:
                yield response

def serve():
    server = grpc.server(concurrent.futures.ThreadPoolExecutor(max_workers=25))
    ep_grpc.add_ExternalProcessorServicer_to_server(EnterpriseTokenInjector(), server)
    server.add_insecure_port(f"0.0.0.0:{PORT}")
    logger.info("Starting Enterprise ext_proc server on port %s", PORT)
    server.start()
    server.wait_for_termination()

if __name__ == "__main__":
    serve()
