#!/usr/bin/env bash
# NorTex Reorder List — deploy or update, from AWS CloudShell (or any shell with the AWS CLI).
#   First time:  bash deploy.sh          (asks for the Account Owner's details at the end)
#   Updates:     bash deploy.sh          (same command; data is never touched)
#   Texted sign-in codes off/on:  TEXT_CODES=off bash deploy.sh   /   TEXT_CODES=on bash deploy.sh
#                (the choice is kept for later updates until you change it)
# Optional: APP=other-name bash deploy.sh   -> a completely separate copy (e.g. for another business)
set -euo pipefail
cd "$(dirname "$0")"

APP="${APP:-nortex-reorder}"
REGION="${AWS_REGION:-$(aws configure get region || true)}"
REGION="${REGION:-us-east-1}"
TEXT_CODES="$(echo "${TEXT_CODES:-}" | tr 'A-Z' 'a-z')"
case "$TEXT_CODES" in ''|on|off) ;; *) echo "TEXT_CODES must be on or off."; exit 1;; esac
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ART="${APP}-deploy-${ACCOUNT}-${REGION}"
say(){ printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

say "Account ${ACCOUNT}, region ${REGION}, app '${APP}'"

# 1) bucket that holds the packaged API code
if ! aws s3api head-bucket --bucket "$ART" 2>/dev/null; then
  say "Creating deployment bucket ${ART}"
  if [ "$REGION" = "us-east-1" ]; then aws s3api create-bucket --bucket "$ART" --region "$REGION" >/dev/null
  else aws s3api create-bucket --bucket "$ART" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null; fi
  aws s3api put-public-access-block --bucket "$ART" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

# 2) infrastructure (first run takes ~5–10 minutes, mostly CloudFront)
say "Packaging and deploying the stack (first time: 5–10 minutes)"
aws cloudformation package --template-file template.yaml --s3-bucket "$ART" --s3-prefix "$APP" --output-template-file .packaged.yaml >/dev/null
aws cloudformation deploy --template-file .packaged.yaml --stack-name "$APP" --region "$REGION" \
  --capabilities CAPABILITY_IAM --parameter-overrides AppName="$APP" ${TEXT_CODES:+TextCodes="$TEXT_CODES"} --no-fail-on-empty-changeset

out(){ aws cloudformation describe-stacks --stack-name "$APP" --region "$REGION" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
SITE="$(out SiteUrl)"; API="$(out ApiUrl)"; CLIENT="$(out ClientId)"; BUCKET="$(out SiteBucketName)"
DIST="$(out DistributionId)"; FN="$(out FunctionName)"; MAIN="$(out MainTableName)"

# 3) website files, with this deployment's settings
say "Uploading the website"
BUILD="$(mktemp -d)"; cp -r web/. "$BUILD/"
cat > "$BUILD/config.js" <<EOF
window.NORTEX_CONFIG = {"region":"${REGION}","clientId":"${CLIENT}","apiUrl":"${API}"};
EOF
sed -i "s# http://localhost:8790##" "$BUILD/index.html" "$BUILD/host.html"      # the local test address isn't allowed in the live app
aws s3 sync "$BUILD" "s3://${BUCKET}" --delete --exclude "*.png" --cache-control "no-cache" >/dev/null
aws s3 sync "$BUILD" "s3://${BUCKET}" --exclude "*" --include "*.png" --cache-control "max-age=86400" >/dev/null
aws s3 cp "$BUILD/manifest.webmanifest" "s3://${BUCKET}/manifest.webmanifest" --content-type "application/manifest+json" --cache-control "no-cache" >/dev/null
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" >/dev/null
rm -rf "$BUILD"

# 4) first time only: the Account Owner login and the first pharmacy
OWNERS="$(aws dynamodb query --table-name "$MAIN" --region "$REGION" --key-condition-expression 'pk = :p' \
  --filter-expression 'attribute_exists(#o) AND #o = :t' --expression-attribute-names '{"#o":"owner"}' \
  --expression-attribute-values '{":p":{"S":"USERS"},":t":{"BOOL":true}}' --select COUNT --query Count --output text)"
if [ "$OWNERS" = "0" ]; then
  say "First-time setup: the Account Owner (the business owner) and the first pharmacy"
  echo "Only the Account Owner can add people and pharmacies and switch access on/off."
  read -rp "Account Owner's full name: " NAME
  read -rp "Account Owner's Login ID (e.g. jsmith): " LOGIN
  read -rp "Account Owner's mobile number (sign-in codes are texted here): " PHONE
  read -rp "First pharmacy's Pharmacy ID (typed at sign-in, e.g. NTX1): " PID
  read -rp "First pharmacy's name: " PNAME
  read -rp "First pharmacy's time zone: 1 Eastern, 2 Central, 3 Mountain, 4 Arizona, 5 Pacific [2]: " TZN
  case "${TZN:-2}" in 1) TZ_ID=America/New_York;; 3) TZ_ID=America/Denver;; 4) TZ_ID=America/Phoenix;; 5) TZ_ID=America/Los_Angeles;; *) TZ_ID=America/Chicago;; esac
  PAYLOAD="$(jq -n --arg n "$NAME" --arg l "$LOGIN" --arg p "$PHONE" --arg i "$PID" --arg s "$PNAME" --arg z "$TZ_ID" \
    '{bootstrap:{name:$n, login:$l, phone:$p, storeId:$i, storeName:$s, timezone:$z}}')"
  aws lambda invoke --function-name "$FN" --region "$REGION" --cli-binary-format raw-in-base64-out --payload "$PAYLOAD" .boot.json >/dev/null
  echo; jq -r '.message // .errorMessage // .' .boot.json; rm -f .boot.json
  echo "Give the Account Owner: the web address below, their Pharmacy ID, Login ID and that temporary password."
fi

if [ "$TEXT_CODES" = on ]; then                     # codes back on: make sure every login gets them
  POOL="$(out UserPoolId)"
  for u in $(aws cognito-idp list-users --user-pool-id "$POOL" --region "$REGION" --query 'Users[].Username' --output text); do
    aws cognito-idp admin-set-user-mfa-preference --user-pool-id "$POOL" --username "$u" --region "$REGION" \
      --sms-mfa-settings Enabled=true,PreferredMfa=true >/dev/null 2>&1 || true
  done
fi
CODES="$(aws cloudformation describe-stacks --stack-name "$APP" --region "$REGION" --query "Stacks[0].Parameters[?ParameterKey=='TextCodes'].ParameterValue" --output text)"

say "Done"
if [ "$CODES" = off ]; then echo "Texted sign-in codes: OFF (password only). Turn back on: TEXT_CODES=on bash deploy.sh"
else echo "Texted sign-in codes: ON"; fi
echo "Web address:  ${SITE}"
echo "Updates: run 'bash deploy.sh' again. Lists, archives and logins are never touched by an update."
