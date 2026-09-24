# Vendored: @pdpp/connector-manager

Source: `packages/connector-installer-core` in
[PDP-Connect/data-connectors](https://github.com/PDP-Connect/data-connectors)
at commit `dbb538d` (2026-09-23). Apache-2.0; see `LICENSE` and `NOTICE`.

The package is `"private": true` and not published to npm, and vana-cli ships
to npm, so it cannot depend on it through a git URL. Vana Desktop installs the
same code from a pinned commit. Vendoring keeps artifact verification identical
to Desktop: the same Sigstore issuer, the same signer identity, the same digest
checks.

The files are copied unmodified. `pnpm build` copies this directory to
`dist/vendor/`. Its npm dependencies (`sigstore`, `@sigstore/bundle`, `ajv`,
`tar`) are declared in vana-cli's own `package.json`.

To refresh, from a data-connectors checkout:

```bash
for f in index.mjs retry.mjs oci-registry.mjs oci-verify.mjs tar-stream.mjs \
  oci-catalog.mjs catalog-schema.mjs catalog-schema-data.mjs LICENSE NOTICE package.json; do
  git show <commit>:packages/connector-installer-core/$f > src/vendor/pdpp-connector-manager/$f
done
```

Then update the commit above and check the dependency ranges in its
`package.json` against vana-cli's.
