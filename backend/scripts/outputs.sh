#!/usr/bin/env bash
# Print the stack outputs (board URL, API URL, AppSync Events endpoints, Cognito ids).
set -euo pipefail
aws cloudformation describe-stacks --region "${AWS_REGION:-us-east-1}" --stack-name "${H1_STACK:-HackathonOne}" \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
