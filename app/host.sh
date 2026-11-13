#!/usr/bin/env bash
# Host tools (run in AWS CloudShell, in the folder with deploy.sh). For the web host only.
#   bash host.sh people                    list logins, phones, status
#   bash host.sh reset-password LOGIN      new temporary password (they choose their own at next sign-in)
#   bash host.sh set-phone LOGIN NUMBER    change the mobile number that gets the sign-in codes
#   bash host.sh off LOGIN | on LOGIN      switch a login off (signed out everywhere) or back on
#   bash host.sh pharmacies                list pharmacies
#   bash host.sh add-pharmacy ID "NAME" [eastern|central|mountain|arizona|pacific]
#   bash host.sh assign LOGIN PHARMACY_ID     give a person access to a pharmacy
#   bash host.sh unassign LOGIN PHARMACY_ID   take that access away
#   bash host.sh make-host LOGIN "NAME" NUMBER  create your own host login for the host page (web address/host.html)
#   bash host.sh remove-host LOGIN           remove an extra host login (never the last one)
# Optional: APP=other-name bash host.sh ...   for a separate copy
set -euo pipefail
APP="${APP:-nortex-reorder}"
REGION="${AWS_REGION:-$(aws configure get region || true)}"; REGION="${REGION:-us-east-1}"
out(){ aws cloudformation describe-stacks --stack-name "$APP" --region "$REGION" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
POOL="${POOL:-$(out UserPoolId)}"; MAIN="${MAIN:-$(out MainTableName)}"
cmd="${1:-}"; login="$(echo "${2:-}" | tr 'A-Z' 'a-z')"
need_login(){ [ -n "$login" ] || { echo "Which Login ID?"; exit 1; }; }
sub_of(){ aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$login" --region "$REGION" --query "UserAttributes[?Name=='sub'].Value" --output text; }
temp_pw(){ local p; p="$(LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' </dev/urandom | head -c 10)"; echo "${p}a7"; }

case "$cmd" in
  people)
    aws cognito-idp list-users --user-pool-id "$POOL" --region "$REGION" \
      --query "Users[].[Username, Attributes[?Name=='name']|[0].Value, Attributes[?Name=='phone_number']|[0].Value, UserStatus, Enabled]" --output table ;;
  reset-password)
    need_login; pw="$(temp_pw)"
    aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$login" --password "$pw" --no-permanent --region "$REGION"
    aws cognito-idp admin-user-global-sign-out --user-pool-id "$POOL" --username "$login" --region "$REGION" || true
    sub="$(aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$login" --region "$REGION" --query "UserAttributes[?Name=='sub'].Value | [0]" --output text)"
    aws dynamodb update-item --table-name "$MAIN" --region "$REGION" --key "{\"pk\":{\"S\":\"USERS\"},\"sk\":{\"S\":\"$sub\"}}" \
      --update-expression "SET tempIssuedAt = :n" --condition-expression "attribute_exists(sk)" \
      --expression-attribute-values "{\":n\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}}" >/dev/null 2>&1 || true
    echo "Temporary password for ${login}: ${pw}   (good for 3 days; they choose their own at the next sign-in)" ;;
  set-phone)
    need_login; num="$(echo "${3:-}" | tr -dc '0-9')"
    [ ${#num} -eq 10 ] && num="+1${num}" || { [ ${#num} -eq 11 ] && [ "${num:0:1}" = 1 ] && num="+${num}"; } || { echo "Give a 10-digit US mobile number."; exit 1; }
    aws cognito-idp admin-update-user-attributes --user-pool-id "$POOL" --username "$login" --region "$REGION" \
      --user-attributes Name=phone_number,Value="$num" Name=phone_number_verified,Value=true
    sub="$(sub_of)"
    aws dynamodb update-item --table-name "$MAIN" --region "$REGION" --key "{\"pk\":{\"S\":\"USERS\"},\"sk\":{\"S\":\"${sub}\"}}" \
      --update-expression "SET phone = :p" --expression-attribute-values "{\":p\":{\"S\":\"${num}\"}}" >/dev/null
    echo "Sign-in codes for ${login} now go to ${num}." ;;
  off|on)
    need_login; sub="$(sub_of)"
    if [ "$cmd" = off ]; then
      aws cognito-idp admin-disable-user --user-pool-id "$POOL" --username "$login" --region "$REGION"
      aws cognito-idp admin-user-global-sign-out --user-pool-id "$POOL" --username "$login" --region "$REGION" || true
      val=true
    else aws cognito-idp admin-enable-user --user-pool-id "$POOL" --username "$login" --region "$REGION"; val=false; fi
    aws dynamodb update-item --table-name "$MAIN" --region "$REGION" --key "{\"pk\":{\"S\":\"USERS\"},\"sk\":{\"S\":\"${sub}\"}}" \
      --update-expression "SET disabled = :d" --expression-attribute-values "{\":d\":{\"BOOL\":${val}}}" >/dev/null
    echo "Login ${login} switched ${cmd}." ;;
  pharmacies)
    aws dynamodb query --table-name "$MAIN" --region "$REGION" --key-condition-expression 'pk = :p' \
      --expression-attribute-values '{":p":{"S":"STORES"}}' --query 'Items[].[sk.S, name.S, timezone.S]' --output table ;;
  add-pharmacy)
    pid="$(echo "${2:-}" | tr 'a-z' 'A-Z')"; pname="${3:-}"
    [[ "$pid" =~ ^[A-Z0-9][A-Z0-9-]{1,19}$ ]] || { echo "Pharmacy ID: 2-20 letters, numbers or dashes (e.g. NTX2)."; exit 1; }
    [ -n "$pname" ] || { echo "Give the pharmacy name in quotes."; exit 1; }
    case "$(echo "${4:-central}" | tr 'A-Z' 'a-z')" in eastern) tz=America/New_York;; mountain) tz=America/Denver;; arizona) tz=America/Phoenix;; pacific) tz=America/Los_Angeles;; *) tz=America/Chicago;; esac
    item="$(jq -n --arg id "$pid" --arg n "$pname" --arg z "$tz" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{pk:{S:"STORES"}, sk:{S:$id}, name:{S:$n}, timezone:{S:$z}, createdAt:{S:$t}}')"
    aws dynamodb put-item --table-name "$MAIN" --region "$REGION" --item "$item" --condition-expression 'attribute_not_exists(pk)' 2>/dev/null \
      || { echo "That Pharmacy ID is already used (see: bash host.sh pharmacies)."; exit 1; }
    echo "Pharmacy ${pid} (${pname}) added. Address, phone, fax, email, license and logo can be filled in from the Account Manager tab." ;;
  assign|unassign)
    need_login; pid="$(echo "${3:-}" | tr 'a-z' 'A-Z')"; [ -n "$pid" ] || { echo "Which Pharmacy ID?"; exit 1; }
    found="$(aws dynamodb get-item --table-name "$MAIN" --region "$REGION" --key "{\"pk\":{\"S\":\"STORES\"},\"sk\":{\"S\":\"${pid}\"}}" --query 'Item.sk.S' --output text)"
    [ "$found" = "$pid" ] || { echo "No pharmacy with ID ${pid} (see: bash host.sh pharmacies)."; exit 1; }
    sub="$(sub_of)"; val=$([ "$cmd" = assign ] && echo true || echo false)
    aws dynamodb update-item --table-name "$MAIN" --region "$REGION" --key "{\"pk\":{\"S\":\"USERS\"},\"sk\":{\"S\":\"${sub}\"}}" \
      --update-expression "SET stores.#p = :v" --expression-attribute-names "{\"#p\":\"${pid}\"}" \
      --expression-attribute-values "{\":v\":{\"BOOL\":${val}}}" --condition-expression 'attribute_exists(stores)' >/dev/null
    echo "${login}: access to ${pid} switched $([ "$cmd" = assign ] && echo on || echo off)." ;;
  make-host)
    need_login; hname="${3:-}"; num="$(echo "${4:-}" | tr -dc '0-9')"
    [ -n "$hname" ] || { echo "Give your name in quotes, then your 10-digit mobile number."; exit 1; }
    [ ${#num} -eq 10 ] || [ ${#num} -eq 11 ] || { echo "Give a 10-digit US mobile number."; exit 1; }
    payload="$(jq -cn --arg l "$login" --arg n "$hname" --arg p "$num" --arg t "$(temp_pw)" '{makeHost:{login:$l, name:$n, phone:$p, tempPassword:$t}}')"
    aws lambda invoke --function-name "$(out FunctionName)" --region "$REGION" --cli-binary-format raw-in-base64-out --payload "$payload" .host.json >/dev/null
    jq -r '.message // .errorMessage // .' .host.json; rm -f .host.json
    site="$(out SiteUrl 2>/dev/null || true)"
    [ -n "$site" ] && [ "$site" != "None" ] && echo "Host page: ${site%/}/host.html"
    echo "Sign in there with that Login ID and temporary password (no Pharmacy ID). A code is texted to your phone." ;;
  remove-host)
    need_login
    p="$(aws dynamodb query --table-name "$MAIN" --region "$REGION" --key-condition-expression "pk = :p" --expression-attribute-values '{":p":{"S":"USERS"}}' --output json | jq -c --arg l "$login" '[.Items[] | select(.login.S == $l and (.deleted.BOOL // false | not))][0]')"
    [ "$p" != "null" ] || { echo "No login \"$login\" in the list."; exit 1; }
    [ "$(echo "$p" | jq -r '.host.BOOL // false')" = true ] || { echo "\"$login\" is not a host login. Delete staff from the Account Manager tab or the host page."; exit 1; }
    hosts="$(aws dynamodb query --table-name "$MAIN" --region "$REGION" --key-condition-expression "pk = :p" --expression-attribute-values '{":p":{"S":"USERS"}}' --output json | jq '[.Items[] | select((.host.BOOL // false) and (.deleted.BOOL // false | not))] | length')"
    [ "$hosts" -gt 1 ] || { echo "That is the only host login. Not removed."; exit 1; }
    sub="$(echo "$p" | jq -r '.sk.S')"
    aws cognito-idp admin-user-global-sign-out --user-pool-id "$POOL" --username "$login" --region "$REGION" >/dev/null 2>&1 || true
    aws cognito-idp admin-delete-user --user-pool-id "$POOL" --username "$login" --region "$REGION" 2>/dev/null || true
    aws dynamodb update-item --table-name "$MAIN" --region "$REGION" --key "{\"pk\":{\"S\":\"USERS\"},\"sk\":{\"S\":\"$sub\"}}" \
      --update-expression "SET deleted = :t, disabled = :t, deletedAt = :n, deletedBy = :b" \
      --expression-attribute-values "{\":t\":{\"BOOL\":true},\":n\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"},\":b\":{\"S\":\"host (CloudShell)\"}}" >/dev/null
    echo "Host login \"$login\" removed." ;;
  *) sed -n '2,13p' "$0" ;;
esac
