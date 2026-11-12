import boto3, json, sys
kw = dict(endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
d = boto3.client("dynamodb", **kw); c = boto3.client("cognito-idp", **kw)
for t in ("nortex-reorder-main","nortex-reorder-archive"):
    try: d.delete_table(TableName=t)
    except Exception: pass
    d.create_table(TableName=t, BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName":"pk","AttributeType":"S"},{"AttributeName":"sk","AttributeType":"S"}],
        KeySchema=[{"AttributeName":"pk","KeyType":"HASH"},{"AttributeName":"sk","KeyType":"RANGE"}])
pool = c.create_user_pool(PoolName="nortex-reorder-users", UsernameConfiguration={"CaseSensitive":False},
    Policies={"PasswordPolicy":{"MinimumLength":10,"RequireLowercase":True,"RequireUppercase":False,"RequireNumbers":True,"RequireSymbols":False}})["UserPool"]
cl = c.create_user_pool_client(UserPoolId=pool["Id"], ClientName="web", GenerateSecret=False,
    ExplicitAuthFlows=["ALLOW_USER_PASSWORD_AUTH","ALLOW_REFRESH_TOKEN_AUTH"])["UserPoolClient"]
json.dump({"pool":pool["Id"],"client":cl["ClientId"]}, open("moto_ids.json","w")); print(pool["Id"], cl["ClientId"])
