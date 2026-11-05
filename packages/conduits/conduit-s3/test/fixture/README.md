# Fixtures — two conforming servers (FJS-D889)

Neither runs on the machine this was written on (no docker), so the fixture
rows are **unproved**. Start one, then run the drive with the variables below.

```sh
# MinIO
docker run --rm -p 9000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio:RELEASE.2025-09-07T16-13-09Z server /data
# make the bucket once: mc alias set local http://127.0.0.1:9000 minioadmin minioadmin && mc mb local/drive
FIXTURE_URL=http://127.0.0.1:9000 FIXTURE_CREDENTIAL=minioadmin:minioadmin FIXTURE_REGION=us-east-1 FIXTURE_BUCKET=drive bun run drive

# SeaweedFS — the image frontierjs's verify:replicate already pins
docker run --rm -p 8333:8333 chrislusf/seaweedfs:4.47 server -s3 -dir=/data
FIXTURE_URL=http://127.0.0.1:8333 FIXTURE_CREDENTIAL=any:any FIXTURE_REGION=us-east-1 FIXTURE_BUCKET=drive bun run drive
```
