# pila factcheck — AWS deployment (POC)

Handoff for whoever ships `apps/api`. The pipe **URL → CloudFront → Lambda → @pila/factcheck** is live and verified
with a smoke handler (`infra/aws/smoke/handler.ts`). Replace that handler with `apps/api`; nothing else needs to change.

Account `799870512242`, region `us-west-2`, default AWS profile. Every resource is tagged `project=pila, env=poc`.

```
client ──HTTPS──▶ CloudFront ──adds x-origin-verify──▶ Lambda Function URL ──▶ Lambda (Node.js 22, arm64, zip)
                  https://d3tuhog92nak7r.cloudfront.net                         reads keys from SSM at cold start
```

## Public endpoint

**`https://d3tuhog92nak7r.cloudfront.net`** — the only URL clients should use.

## Resources

| Resource | Name / ID | Settings |
|---|---|---|
| CloudFront | `EIBEI9CMOK3TU` | PriceClass_100, caching off (`CachingDisabled`), `AllViewerExceptHostHeader` origin policy, all methods, HTTPS redirect, origin read timeout **60 s** |
| Lambda | `pila-factcheck` | `nodejs22.x`, arm64, zip, handler `index.handler`, 512 MB, timeout **60 s**, reserved concurrency **5** |
| Function URL | `https://4qigmpqu4wrhkst6ijpt227whu0xjnlc.lambda-url.us-west-2.on.aws/` | auth `NONE`; the handler rejects requests without the right `x-origin-verify` (403) |
| IAM role | `pila-factcheck-lambda` | `AWSLambdaBasicExecutionRole` + inline `read-pila-ssm` (`ssm:GetParameter(s)` on `/pila/factcheck/*`) |
| SSM (SecureString) | `/pila/factcheck/origin-secret` | value CloudFront sends in `x-origin-verify` |
| SSM (SecureString) | `/pila/factcheck/typesafe-api-key` | Jev key (copied from repo `.env`) |
| SSM (SecureString) | `/pila/factcheck/tavily-api-key` | Tavily key (copied from repo `.env`) |
| CloudWatch Logs | `/aws/lambda/pila-factcheck` | 7-day retention |
| ECR | `pila-factcheck` | empty, unused (zip deploy). Keep for a container switch or delete. |

## Contract the smoke handler implements

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | — | `200 { success: true, data: { ok: true }, error: null }` |
| POST | `/factcheck` | `{ transcript: Transcript, video?: { title, channel } }` | `200 { success, data: FactCheckResult[], error }` |
| OPTIONS | any | — | `204`, CORS `*` |

Errors: `400` invalid input, `403` missing/wrong `x-origin-verify`, `404` unknown route, `502` Jev/Tavily failure, `500` other.

## Rules for `apps/api` on this stack

1. **Lambda entry**: export `handler` from Hono's `hono/aws-lambda` adapter (`handle(app)`). The event is a Function URL
   event (payload v2: `rawPath`, `requestContext.http.method`).
2. **Origin check**: reject requests whose `x-origin-verify` header ≠ SSM `/pila/factcheck/origin-secret`. Without it,
   anyone can bypass CloudFront and hit the Function URL.
3. **Timeout**: finish within **55 s** (`AbortSignal.timeout(55_000)`). CloudFront cuts the connection at 60 s, and
   so does Lambda. `apps/api` currently defaults `requestTimeoutMs` to 90 s; lower it. Longer jobs need an async design
   (return a job id, poll) or a CloudFront quota increase (up to 180 s) plus a longer Lambda timeout.
4. **Secrets**: read from SSM (see the smoke handler `loadSecrets`), not from Lambda env vars. `@aws-sdk/*` is in
   the Lambda runtime; mark it `--external` when bundling.
5. **In-memory rate limit and cache are per container.** Up to 5 containers run at once, so limits are about 5× looser.
   OK for the POC. Reserved concurrency 5 is the hard cap on spend.
6. **Body size**: Function URL limit is 6 MB request and 6 MB response.
7. **Logs**: stdout/stderr go to CloudWatch. Never log API keys or the origin secret.

## Build and deploy

```sh
# from repo root; swap the entry for apps/api's Lambda entry when ready
node_modules/.bin/esbuild infra/aws/smoke/handler.ts --bundle --platform=node --target=node22 --format=esm \
  --external:@aws-sdk/* --outfile=infra/aws/smoke/dist/index.mjs
(cd infra/aws/smoke/dist && zip -q ../function.zip index.mjs)
aws lambda update-function-code --region us-west-2 --function-name pila-factcheck \
  --zip-file fileb://infra/aws/smoke/function.zip
aws lambda wait function-updated-v2 --region us-west-2 --function-name pila-factcheck
```

The bundle must be ESM named `index.mjs` exporting `handler`, or change the Lambda handler setting:
`aws lambda update-function-configuration --region us-west-2 --function-name pila-factcheck --handler <file>.<export>`.

New env vars (non-secret): `aws lambda update-function-configuration --region us-west-2 --function-name pila-factcheck --environment "Variables={KEY=value}"` (this replaces the whole set).

Rotate a key: `aws ssm put-parameter --region us-west-2 --name /pila/factcheck/<name> --type SecureString --value '<v>' --overwrite`.
Running containers keep the old value until they recycle; force it with any `update-function-configuration`.

## Verify

```sh
curl -s https://d3tuhog92nak7r.cloudfront.net/health                                   # 200
curl -s https://4qigmpqu4wrhkst6ijpt227whu0xjnlc.lambda-url.us-west-2.on.aws/health    # 403 (bypass blocked)
curl -s -X POST -H 'content-type: application/json' https://d3tuhog92nak7r.cloudfront.net/factcheck -d '{
  "video": {"title": "Climate change basics", "channel": "demo"},
  "transcript": {"videoId": "smoke-1", "sentences": [
    {"id": "s1", "text": "The Great Wall of China is visible from the Moon with the naked eye.", "startSeconds": 0, "endSeconds": 5}]}}'
# 200, verdict "misinformation", Snopes source, ~9 s
aws logs tail /aws/lambda/pila-factcheck --region us-west-2 --since 10m
```

## Cost (POC traffic)

Lambda and CloudFront free tiers cover light use; idle cost is about $0. SSM standard parameters are free.
The real cost is Jev and Tavily credits: the endpoint is public, so anyone with the URL can spend them.
Add API tokens (`PILA_API_TOKENS` in `apps/api`) before sharing the URL.

## Teardown

```sh
ETAG=$(aws cloudfront get-distribution-config --id EIBEI9CMOK3TU --query ETag --output text)
aws cloudfront get-distribution-config --id EIBEI9CMOK3TU --query DistributionConfig > /tmp/cf.json
# set "Enabled": false in /tmp/cf.json, then:
aws cloudfront update-distribution --id EIBEI9CMOK3TU --if-match $ETAG --distribution-config file:///tmp/cf.json
aws cloudfront wait distribution-deployed --id EIBEI9CMOK3TU
aws cloudfront delete-distribution --id EIBEI9CMOK3TU --if-match $(aws cloudfront get-distribution-config --id EIBEI9CMOK3TU --query ETag --output text)
aws lambda delete-function --region us-west-2 --function-name pila-factcheck
aws iam delete-role-policy --role-name pila-factcheck-lambda --policy-name read-pila-ssm
aws iam detach-role-policy --role-name pila-factcheck-lambda --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name pila-factcheck-lambda
aws ssm delete-parameters --region us-west-2 --names /pila/factcheck/origin-secret /pila/factcheck/typesafe-api-key /pila/factcheck/tavily-api-key
aws logs delete-log-group --region us-west-2 --log-group-name /aws/lambda/pila-factcheck
aws ecr delete-repository --region us-west-2 --repository-name pila-factcheck --force
```
