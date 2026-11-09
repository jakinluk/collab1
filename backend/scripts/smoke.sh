#!/usr/bin/env bash
# Post-deploy smoke test: the API answers through CloudFront and refuses direct and anonymous calls.
set -euo pipefail
STACK="${C1_STACK:-CollabOne}"
REGION="${AWS_REGION:-us-east-1}"
out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
API=$(out ApiUrl)
echo "health:      $(curl -s -o /dev/null -w '%{http_code}' "$API/health") (want 200)"
echo "anonymous:   $(curl -s -o /dev/null -w '%{http_code}' "$API/me") (want 401)"
echo "bad token:   $(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer c1a_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' "$API/me") (want 401/403)"
echo "bad join:    $(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"code":"AAAA-AAAA","machine":"smoke"}' "$API/join") (want 401)"
APIGW=$(aws apigatewayv2 get-apis --region "$REGION" --query "Items[?Description=='CollabOne API (reachable only through CloudFront)'].ApiEndpoint | [0]" --output text)
echo "direct API:  $(curl -s -o /dev/null -w '%{http_code}' "$APIGW/api/v1/health") (want 403)"
