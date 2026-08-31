import assert from "node:assert/strict";
import test from "node:test";

import { hasPersistentVendorSource } from "../scripts/persistent_vendor_sources.mjs";

test("preserves vendors maintained by discovery and dedicated importers", () => {
  for (const source of [
    "github-discovery",
    "github-openseo-official",
    "github-goldmansachs-official"
  ]) {
    assert.equal(hasPersistentVendorSource({ sources: [source] }), true, source);
  }
});

test("does not preserve records owned only by scraped catalogs", () => {
  assert.equal(hasPersistentVendorSource({ sources: ["skills.sh", "officialskills.sh"] }), false);
  assert.equal(hasPersistentVendorSource({}), false);
  assert.equal(hasPersistentVendorSource(null), false);
});
