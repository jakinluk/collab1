#!/usr/bin/env bash
# Invite people to the HackathonOne board (Cognito, invite-only, MFA required).
# Usage: scripts/invite.sh ania@example.com bob@example.com ...
set -euo pipefail
STACK="${H1_STACK:-HackathonOne}"
REGION="${AWS_REGION:-us-east-1}"
[ $# -gt 0 ] || { echo "usage: $0 email [email...]" >&2; exit 1; }
POOL=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
BOARD=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='BoardUrl'].OutputValue" --output text)
for email in "$@"; do
  aws cognito-idp admin-create-user --region "$REGION" --user-pool-id "$POOL" --username "$email" \
    --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
    --desired-delivery-mediums EMAIL >/dev/null
  echo "invited $email"
done
echo "Board: $BOARD  (send this link to the people you invited)"
