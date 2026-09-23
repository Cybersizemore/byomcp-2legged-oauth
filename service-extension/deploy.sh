#!/bin/bash
# ==============================================================================
# Enterprise BYO-MCP 2-Legged Auth Setup with Agent Gateway & Service Extensions
# ==============================================================================
set -euo pipefail

# ------------------------------------------------------------------------------
# 1. Environment & Project Variables (Edit as needed)
# ------------------------------------------------------------------------------
export PROJECT_ID=$(gcloud config get-value project)
export PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
export REGION="${REGION:-us-central1}"
export AGENT_GATEWAY_NAME="${AGENT_GATEWAY_NAME:-agw-enterprise-egress}"
export REPO_NAME="enterprise-mcp-tools"
export IMAGE_NAME="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/enterprise-extproc:latest"
export SERVICE_ACCOUNT_NAME="enterprise-mcp-extproc"
export SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "=============================================================================="
echo "Project ID:           ${PROJECT_ID} (${PROJECT_NUMBER})"
echo "Region:               ${REGION}"
echo "Agent Gateway:        ${AGENT_GATEWAY_NAME}"
echo "Service Account:      ${SERVICE_ACCOUNT_EMAIL}"
echo "=============================================================================="

# ------------------------------------------------------------------------------
# 2. Enable Required Google Cloud APIs
# ------------------------------------------------------------------------------
echo "Enabling required APIs..."
gcloud services enable \
    networkservices.googleapis.com \
    networksecurity.googleapis.com \
    compute.googleapis.com \
    run.googleapis.com \
    artifactregistry.googleapis.com \
    discoveryengine.googleapis.com \
    secretmanager.googleapis.com \
    --project="${PROJECT_ID}"

# ------------------------------------------------------------------------------
# 3. Create Customer-Managed Service Account (CMSA)
# ------------------------------------------------------------------------------
if ! gcloud iam service-accounts describe "${SERVICE_ACCOUNT_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "Creating Customer-Managed Service Account: ${SERVICE_ACCOUNT_NAME}..."
    gcloud iam service-accounts create "${SERVICE_ACCOUNT_NAME}" \
        --display-name="Enterprise MCP Egress Token Injector" \
        --project="${PROJECT_ID}"
else
    echo "Service Account ${SERVICE_ACCOUNT_EMAIL} already exists."
fi

# ------------------------------------------------------------------------------
# 4. Build and Push Container Image to Artifact Registry
# ------------------------------------------------------------------------------
echo "Configuring Artifact Registry..."
if ! gcloud artifacts repositories describe "${REPO_NAME}" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud artifacts repositories create "${REPO_NAME}" \
        --repository-format=docker \
        --location="${REGION}" \
        --project="${PROJECT_ID}" \
        --description="Docker repository for Enterprise MCP extensions"
fi

echo "Building and submitting container image via Cloud Build..."
gcloud builds submit --tag "${IMAGE_NAME}" . --project="${PROJECT_ID}"

# ------------------------------------------------------------------------------
# 5. Deploy ext_proc Microservice to Cloud Run (gRPC enabled)
# ------------------------------------------------------------------------------
echo "Deploying enterprise-extproc to Cloud Run..."
gcloud run deploy enterprise-extproc \
    --image="${IMAGE_NAME}" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --service-account="${SERVICE_ACCOUNT_EMAIL}" \
    --use-http2 \
    --port=50051 \
    --ingress=internal \
    --allow-unauthenticated \
    --min-instances=1 \
    --max-instances=10 \
    --cpu=1 \
    --memory=512Mi \
    --quiet

# ------------------------------------------------------------------------------
# 6. Create Serverless NEG & Backend Service for Agent Gateway Callout
# ------------------------------------------------------------------------------
echo "Setting up Network Endpoint Group and Backend Service..."
if ! gcloud compute network-endpoint-groups describe enterprise-extproc-neg --region="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud compute network-endpoint-groups create enterprise-extproc-neg \
        --region="${REGION}" \
        --network-endpoint-type=SERVERLESS \
        --cloud-run-service=enterprise-extproc \
        --project="${PROJECT_ID}"
fi

if ! gcloud compute backend-services describe enterprise-extproc-backend --region="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud compute backend-services create enterprise-extproc-backend \
        --load-balancing-scheme=INTERNAL_MANAGED \
        --protocol=GRPC \
        --region="${REGION}" \
        --project="${PROJECT_ID}"

    gcloud compute backend-services add-backend enterprise-extproc-backend \
        --region="${REGION}" \
        --network-endpoint-group=enterprise-extproc-neg \
        --network-endpoint-group-region="${REGION}" \
        --project="${PROJECT_ID}"
fi

# ------------------------------------------------------------------------------
# 7. Apply AuthzExtension & AuthzPolicy to Agent Gateway
# ------------------------------------------------------------------------------
echo "Templating Authz YAML resources..."
envsubst < authz-extension.yaml > authz-extension.resolved.yaml
envsubst < authz-policy.yaml > authz-policy.resolved.yaml

echo "Applying AuthzExtension..."
gcloud network-services authz-extensions import enterprise-token-injector-ext \
    --location="${REGION}" \
    --source=authz-extension.resolved.yaml \
    --project="${PROJECT_ID}"

echo "Applying AuthzPolicy to Agent Gateway..."
gcloud network-security authz-policies import enterprise-token-injector-policy \
    --location="${REGION}" \
    --source=authz-policy.resolved.yaml \
    --project="${PROJECT_ID}"

echo "=============================================================================="
echo "Deployment Complete!"
echo "Next Step in Gemini Enterprise Console:"
echo "1. Go to Gemini Enterprise -> Data Stores -> Create Data Store"
echo "2. Select 'Custom MCP Server'"
echo "3. Under Authentication Type, select: 'No Auth'"
echo "4. Enter MCP Server URL (routing through Agent Gateway to Enterprise Proxy)"
echo "=============================================================================="
