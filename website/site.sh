#!/usr/bin/env bash
# IronLedger website -> https://ironledgerrx.com   (run in AWS CloudShell)
#   First time and every update:  bash site.sh
# Needs: the domain's hosted zone in Route 53 in this AWS account. Runs in us-east-1 (required for the
# https certificate that CloudFront uses), whatever region the reorder app is in.
set -euo pipefail
cd "$(dirname "$0")"
DOMAIN="${DOMAIN:-ironledgerrx.com}"
STACK="${STACK:-ironledger-site}"
REGION=us-east-1
say(){ printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

ZONE="$(aws route53 list-hosted-zones-by-name --dns-name "${DOMAIN}." --query "HostedZones[?Name=='${DOMAIN}.'].Id | [0]" --output text | sed 's#/hostedzone/##')"
if [ -z "$ZONE" ] || [ "$ZONE" = "None" ]; then
  echo "No Route 53 hosted zone for ${DOMAIN} in this account. Route 53 > Hosted zones should list it."; exit 1
fi
say "Domain ${DOMAIN} (hosted zone ${ZONE})"

# an existing website record would clash with the new one: stop and say so instead of overwriting it
EXIST="$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE" \
  --query "ResourceRecordSets[?(Name=='${DOMAIN}.' || Name=='www.${DOMAIN}.') && (Type=='A' || Type=='AAAA' || Type=='CNAME')].[Name,Type]" --output text)"
if [ -n "$EXIST" ] && ! aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1; then
  echo "These records already exist and would clash with the website:"; echo "$EXIST"
  echo "If they point to an old or parked page, delete them in Route 53 > Hosted zones > ${DOMAIN}, then run this again."; exit 1
fi

say "Creating / updating the website (first time: 10–20 minutes while the https certificate is issued)"
aws cloudformation deploy --template-file site.yaml --stack-name "$STACK" --region "$REGION" \
  --parameter-overrides DomainName="$DOMAIN" HostedZoneId="$ZONE" --no-fail-on-empty-changeset

out(){ aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET="$(out BucketName)"; DIST="$(out DistributionId)"
say "Uploading the pages"
aws s3 sync web "s3://${BUCKET}" --delete --cache-control "max-age=300" >/dev/null
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" >/dev/null
say "Done"
echo "Website:        https://${DOMAIN}"
echo "Privacy policy: https://${DOMAIN}/privacy.html"
echo "SMS terms:      https://${DOMAIN}/sms-terms.html"
echo "Consent form:   https://${DOMAIN}/sms-consent.html"
echo "(It can take a few minutes after 'Done' before the address opens everywhere.)"
