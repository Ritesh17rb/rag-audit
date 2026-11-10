# Release checklist

1. Update version, lockfile, and changelog.
2. Run `npm ci`, `npm run check`, and `npm audit`.
3. Confirm Linux/Windows Node 20/22 CI and the real Qdrant integration job pass.
4. Inspect `npm pack --dry-run` and create the tarball with `npm pack`.
5. Run `npm run smoke -- ./rag-audit-VERSION.tgz` in the source checkout. The script creates an isolated consumer, installs the exact tarball, and checks imports, the CLI, demo fixtures, and healthy/defective audits.
6. Commit the reviewed code. Publish the checked tarball using `npm publish ./rag-audit-VERSION.tgz --access public` and complete npm's account authentication if prompted.
7. Wait for registry processing, verify version/integrity, and run `npm --prefer-online run smoke -- rag-audit@VERSION`.
8. Tag the exact source commit and publish a GitHub release with the same tarball and verification notes.

No runtime service deployment is required. Runtime package dependencies are empty. Never place credentials in source files or publish reports containing customer metadata as release assets.
