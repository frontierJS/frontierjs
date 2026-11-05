#!/usr/bin/env bash
# start.sh — a real n8n in docker, owner set up, one API key minted, and the
# two variables the drive reads printed. Stop it with `docker rm -f fjs-n8n-fixture`.
#
#   eval "$(test/fixture/start.sh)" && bun run drive
#
# No volume: the instance is throwaway and the key dies with it. Nothing from
# /tmp is mounted (snap docker cannot see it); everything goes over HTTP.
set -e
NAME=${N8N_FIXTURE_NAME:-fjs-n8n-fixture}
IMAGE=${N8N_IMAGE:-docker.n8n.io/n8nio/n8n:latest}
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p 127.0.0.1:0:5678 \
  -e N8N_SECURE_COOKIE=false -e N8N_DIAGNOSTICS_ENABLED=false -e N8N_PERSONALIZATION_ENABLED=false \
  -e N8N_RUNNERS_ENABLED=true -e N8N_LOG_LEVEL=warn "$IMAGE" >/dev/null
PORT=$(docker port "$NAME" 5678/tcp | head -1 | sed 's/.*://')
URL="http://127.0.0.1:$PORT"
for i in $(seq 1 120); do curl -fsS "$URL/healthz" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$URL/healthz" >/dev/null || { echo "n8n did not come up: docker logs $NAME" >&2; exit 1; }
JAR=$(mktemp)
# /healthz answers before the migrations finish, and owner setup refused in
# that window fails for good: the first try is retried until the session cookie
# exists, and an instance already set up is logged into instead.
for i in $(seq 1 60); do
  curl -sS -c "$JAR" -H 'content-type: application/json' -X POST "$URL/rest/owner/setup" \
    -d '{"email":"drive@fjs.test","firstName":"Drive","lastName":"Fixture","password":"DriveFixture1234!"}' >/dev/null 2>&1 || true
  grep -q n8n-auth "$JAR" && break
  curl -sS -c "$JAR" -H 'content-type: application/json' -X POST "$URL/rest/login" \
    -d '{"emailOrLdapLoginId":"drive@fjs.test","password":"DriveFixture1234!"}' >/dev/null 2>&1 || true
  grep -q n8n-auth "$JAR" && break
  sleep 1
done
grep -q n8n-auth "$JAR" || { echo "no session after owner setup; docker logs $NAME" >&2; exit 1; }
KEY=$(curl -fsS -b "$JAR" -H 'content-type: application/json' -X POST "$URL/rest/api-keys" \
  -d '{"label":"conduit-n8n drive","scopes":["workflow:create","workflow:read","workflow:update","workflow:delete","workflow:list","workflow:activate","workflow:deactivate","execution:read","execution:list","execution:delete","execution:stop","execution:retry","tag:create","tag:read","tag:update","tag:delete","tag:list","workflowTags:list","workflowTags:update","credential:create","credential:delete"],"expiresAt":null}' \
  | sed -n 's/.*"rawApiKey":"\([^"]*\)".*/\1/p')
[ -n "$KEY" ] || { echo "no API key minted — the /rest/api-keys shape changed; docker logs $NAME" >&2; exit 1; }
rm -f "$JAR"
echo "export FIXTURE_URL=$URL FIXTURE_KEY=$KEY"
