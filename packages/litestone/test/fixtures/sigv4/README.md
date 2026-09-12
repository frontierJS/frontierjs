# SigV4 fixtures

Copied unmodified from AWS's signing test suite, `tests/aws-signing-test-suite/v4/` in
[awslabs/aws-c-auth](https://github.com/awslabs/aws-c-auth) at commit
`c4bc791ac6985eedb503e882cd450cc5b344c2f2`, Apache License 2.0.

They are the one oracle for `src/storage/sigv4.js` that this repo did not write: a request, the
canonical request AWS derives from it, and the signature — header-signed and presigned. Every case
uses `service: "service"`, which is why the signer's S3-only parts (`x-amz-content-sha256`,
`UNSIGNED-PAYLOAD`) are keyed on the service rather than always on.

To add a case, copy its directory from the same commit, keeping the six files
`test/storage-sigv4.test.ts` reads. Only the `-unnormalized` variants of the path-normalization
cases describe S3, which never removes dot segments or collapses slashes.
