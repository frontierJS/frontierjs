# Fixture — Plausible Community Edition

Self-hosted Plausible serves the same Stats API v2. It is docker-only
(postgres + clickhouse) and did not run on the machine this was written on,
so the fixture row is **unproved**.

```sh
git clone https://github.com/plausible/community-edition plausible-ce && cd plausible-ce
# follow its README to set BASE_URL and SECRET_KEY_BASE, then:
docker compose up -d
# create a site `shop.test` and an API key in the UI, then:
FIXTURE_URL=http://127.0.0.1:8000 FIXTURE_KEY=<key> FIXTURE_SITE=shop.test bun run drive
```
