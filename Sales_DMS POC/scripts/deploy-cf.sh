#!/bin/bash
# Deploy the Backorder Reliability Agent to SAP BTP Cloud Foundry (nodejs buildpack, no Docker image).
#
#   ./scripts/deploy-cf.sh            # deploy to the org/space you are logged into (asks to confirm)
#   ./scripts/deploy-cf.sh --yes      # no confirmation prompt
#
# Optional environment:
#   AICORE_INSTANCE=<name>            AI Core instance to bind (default: first `aicore` instance in the space)
#   APP_BASIC_AUTH_USER / APP_BASIC_AUTH_PASSWORD   shared login for the POC URL (strongly recommended)
#   SKIP_TESTS=1                      skip `npm test`
#
# Prerequisite in the BTP subaccount (see README): a Destination named MT_TRANSCEND_S4_BASIC pointing at the
# Cloud Connector virtual host for MT dev, and the Cloud Connector connected to this subaccount.
set -euo pipefail

APP="atp-promise-agent"
DESTINATION_INSTANCE="atp-agent-destination"
CONNECTIVITY_INSTANCE="atp-agent-connectivity"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! cf target >/dev/null 2>&1; then
  echo "Not logged in to Cloud Foundry. Run: cf login -a https://api.cf.us10.hana.ondemand.com --sso"
  exit 1
fi

ORG="$(cf target | awk -F': *' '/^org:/ {print $2}')"
SPACE="$(cf target | awk -F': *' '/^space:/ {print $2}')"
API="$(cf target | awk -F': *' '/^API endpoint:/ {print $2}')"
echo "Target: $API  org=\"$ORG\"  space=\"$SPACE\""
if [ "${1:-}" != "--yes" ]; then
  read -r -p "Deploy $APP here? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 1; }
fi

echo "==> Installing and building"
npm ci
[ "${SKIP_TESTS:-}" = "1" ] || npm test
npm run build

ensure_service() {
  local offering="$1" plan="$2" name="$3"
  if cf service "$name" >/dev/null 2>&1; then
    echo "    $name exists"
  else
    echo "    creating $name ($offering/$plan)"
    cf create-service "$offering" "$plan" "$name"
  fi
}

echo "==> Service instances"
ensure_service destination lite "$DESTINATION_INSTANCE"
ensure_service connectivity lite "$CONNECTIVITY_INSTANCE"

echo "==> Pushing (not started yet)"
cf push "$APP" -f manifest.yml --no-start

AICORE_INSTANCE="${AICORE_INSTANCE:-$(cf services 2>/dev/null | awk '$2 == "aicore" {print $1; exit}')}"
if [ -n "$AICORE_INSTANCE" ]; then
  echo "==> Binding AI Core instance $AICORE_INSTANCE"
  cf bind-service "$APP" "$AICORE_INSTANCE"
else
  echo "==> No AI Core instance found - the agent will use its rule-based parser"
fi

if [ -n "${APP_BASIC_AUTH_USER:-}" ] && [ -n "${APP_BASIC_AUTH_PASSWORD:-}" ]; then
  echo "==> Setting basic-auth login"
  cf set-env "$APP" APP_BASIC_AUTH_USER "$APP_BASIC_AUTH_USER" >/dev/null
  cf set-env "$APP" APP_BASIC_AUTH_PASSWORD "$APP_BASIC_AUTH_PASSWORD" >/dev/null
elif ! cf env "$APP" 2>/dev/null | grep -q '^APP_BASIC_AUTH_USER:'; then
  echo "WARNING: no APP_BASIC_AUTH_USER/APP_BASIC_AUTH_PASSWORD set - the app URL will be open to anyone who has it."
fi

echo "==> Starting"
cf start "$APP"

echo ""
cf app "$APP"
echo ""
echo "Check SAP connectivity: open the app > Sample data/SAP pill > Test SAP connection"
echo "  or: curl -X POST https://<route>/api/v1/diagnostics/connectivity"
echo "Logs incl. [AUDIT] lines: cf logs $APP --recent"
