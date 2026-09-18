# IndexNow

The public ownership key is served from `docs/1d32fd44a6874306abd91c8ae5b80efb.txt` at the website root, following [Bing's setup instructions](https://www.bing.com/indexnow/getstarted).

All three GitHub Pages deployment workflows build a content-hash manifest from the generated sitemap. Before deployment, they compare it with the live manifest and save added, changed, and removed URLs in the `indexnow-urls` Actions artifact. After deployment, the script verifies the live key and submits those URLs to Bing in batches of up to 10,000. Bing shares submissions with participating IndexNow engines.

The first deployment establishes a baseline and submits the homepage to verify the integration. Subsequent deployments submit pages whose HTML changed. Changes loaded exclusively from JavaScript or other assets can be submitted explicitly:

```sh
npm run indexnow -- submit https://skillscout.sh/official/
```

HTTP 200 confirms receipt. HTTP 202 confirms receipt with key validation pending. Crawl and indexing status can be checked in Bing Webmaster Tools.

If submission fails, the workflow reports the error after publishing the site. Download the `indexnow-urls` artifact from that run and retry its saved list:

```sh
npm run indexnow -- submit-file /path/to/.indexnow-urls.json
```

Use the saved list to retry the failed submission; a fresh deployment compares against the latest published manifest.
