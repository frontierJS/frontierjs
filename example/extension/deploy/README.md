# Shipping example

Two stores, two review queues, and neither is the API's deploy. This directory
holds packaging; nothing is containerised.

```sh
fli extension:build --browser both      # dist/chrome/ and dist/firefox/
cd extension/dist/chrome  && zip -r ../../deploy/chrome.zip .
cd extension/dist/firefox && zip -r ../../deploy/firefox.zip .
```

- **Chrome Web Store** — upload the zip at the developer dashboard. Review is
  usually days; a permission added since the last version restarts it.
- **AMO (Firefox)** — the `geckoId` in `config/jetty.config.js` is the add-on's
  identity. Changing it after the first upload publishes a different add-on that
  nobody has installed.

**`version` in `config/jetty.config.js` is the manifest's**, and a store
refuses an upload that does not raise it.
