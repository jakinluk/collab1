---
name: init
description: Organizer runbook to set up CollabOne for an event — deploy the serverless hub to the AWS sandbox, invite participants, open the board and create the first project. Run once per event by the organizer.
argument-hint: "[event end time ISO]"
disable-model-invocation: true
---
# Set up CollabOne (organizer, once)

Work through these steps with the human. Ask before any command that deploys or changes AWS resources, and only ever use a **sandbox** AWS account, never production.

1. **Prerequisites.** Confirm Node ≥ 22, AWS CLI v2 with sandbox credentials (`aws sts get-caller-identity`), `git`, and `gh auth status`.
2. **Deploy the hub** from the `collab1` repo, following `backend/README.md`:
   ```bash
   cd backend && npm ci && npm run typecheck && npm test
   npx cdk bootstrap aws://<sandbox-account>/us-east-1   # once per account
   npx cdk deploy -c eventEndsAt=<ISO end of the event> -c domainPrefix=<globally-unique-prefix>
   scripts/smoke.sh
   ```
   Show the human the outputs (`BoardUrl`, `ApiUrl`). The stack is fixed to us-east-1 because CloudFront WAF lives there.
3. **Invite people:** `scripts/invite.sh <email> <email> …`. Each person gets a temporary password by email.
4. **Open the board** (`BoardUrl`), sign in, set a password and an authenticator app (MFA is mandatory), and create the seat.
5. **Connect this Mac:** run `/c1:join`.
6. **First project:** run `/c1:project new`, then `/c1:goal` and `/c1:plan`, and approve each proposal in the board.
7. Tell the human what to share with the team: the board URL, the plugin install commands (`/plugin marketplace add <repo>` and `/plugin install c1@collabone`), and "run `/c1:network` then `/c1:join`".
