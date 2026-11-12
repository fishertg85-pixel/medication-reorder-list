#!/bin/bash
cd "$(dirname "$0")"
pkill -f server.mjs; pkill -f moto.server; sleep 1
(python3 -m moto.server -p 5005 > /tmp/moto.log 2>&1 &) ; sleep 3
python3 setup_moto.py >/dev/null
python3 - <<'PY'
import json; i=json.load(open('moto_ids.json'))
open('../app/web/config.js','w').write("window.NORTEX_CONFIG = %s;\n" % json.dumps({"region":"us-east-1","clientId":i["client"],"apiUrl":"http://localhost:8790/api","cognitoEndpoint":"http://localhost:8790/cognito"}))
PY
node boot.mjs '{"login":"owner","name":"Pat Owner","phone":"8175551234","storeId":"NTX1","storeName":"NorTex Pharmacy - Haslet","tempPassword":"temp12345a"}' >/dev/null
(node server.mjs 8790 > /tmp/dev.log 2>&1 &); sleep 1.5
