# Fixture — n8n in docker

`start.sh` runs `docker.n8n.io/n8nio/n8n` on an ephemeral port, completes
owner setup over `/rest/owner/setup` (retried: `/healthz` answers before the
migrations finish), mints one public-API key over `/rest/api-keys` and prints
the two variables the drive reads. No volume, nothing mounted; the instance
and its key die with the container.

```sh
eval "$(test/fixture/start.sh)" && bun run drive
docker rm -f fjs-n8n-fixture
```

Proved 2026-10-23 against n8n 2.44.6: 9 rows — create, `no_trigger`,
`not_registered`, activate, activate again (idempotent), trigger, the
execution row, `unpublishing` on the delete, delete.

`N8N_IMAGE` pins another tag; `N8N_FIXTURE_NAME` renames the container.
