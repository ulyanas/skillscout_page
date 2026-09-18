import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { changedUrls, createManifest, KEY, ORIGIN, submit, validateUrls } from "../scripts/indexnow.mjs";

test("selects added, updated, and removed pages while skipping unchanged pages", () => {
  const before = { [`${ORIGIN}/`]: "a", [`${ORIGIN}/old/`]: "b", [`${ORIGIN}/same/`]: "c" };
  const after = { [`${ORIGIN}/`]: "d", [`${ORIGIN}/new/`]: "e", [`${ORIGIN}/same/`]: "c" };
  assert.deepEqual(changedUrls(before, after), [`${ORIGIN}/`, `${ORIGIN}/old/`, `${ORIGIN}/new/`]);
  assert.deepEqual(changedUrls(after, after), []);
});

test("accepts only canonical site URLs and deduplicates submissions", () => {
  assert.deepEqual(validateUrls([`${ORIGIN}/`, `${ORIGIN}/`]), [`${ORIGIN}/`]);
  for (const url of ["https://example.com/", "http://skillscout.sh/", `${ORIGIN}/#fragment`, `${ORIGIN}/?query=x`, "https://user@skillscout.sh/"]) {
    assert.throws(() => validateUrls([url]));
  }
});

test("hashes sitemap pages and detects content changes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "indexnow-test-"));
  try {
    await fs.writeFile(path.join(dir, "sitemap.xml"), `<urlset><url><loc>${ORIGIN}/</loc></url></urlset>`);
    await fs.writeFile(path.join(dir, "index.html"), "First version");
    const before = await createManifest(dir);
    assert.deepEqual(await createManifest(dir), before);
    await fs.writeFile(path.join(dir, "index.html"), "Updated version");
    assert.deepEqual(changedUrls(before, await createManifest(dir)), [`${ORIGIN}/`]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("verifies the live key and batches submissions within the protocol limit", async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    return options ? new Response(null, { status: 202 }) : new Response(`${KEY}\n`);
  };
  await submit(Array.from({ length: 10_001 }, (_, i) => `${ORIGIN}/page-${i}/`), fetcher);
  assert.equal(requests[0].url, `${ORIGIN}/${KEY}.txt`);
  const bodies = requests.slice(1).map(({ options }) => JSON.parse(options.body));
  assert.deepEqual(bodies.map((body) => body.urlList.length), [10_000, 1]);
  assert.equal(bodies[0].host, "skillscout.sh");
  assert.equal(bodies[0].key, KEY);
  assert.equal(bodies[0].keyLocation, `${ORIGIN}/${KEY}.txt`);
});

test("skips empty submissions and fails clearly on invalid keys or API errors", async () => {
  await submit([], () => { throw new Error("Unexpected request"); });
  await assert.rejects(submit([`${ORIGIN}/`], async () => new Response("wrong key")), /matching key/);
  for (const status of [403, 422, 429, 500]) {
    await assert.rejects(submit([`${ORIGIN}/`], async (_url, options) =>
      options ? new Response("Request failed", { status }) : new Response(KEY)
    ), new RegExp(`HTTP ${status}`));
  }
});
