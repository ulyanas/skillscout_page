export const PERSISTENT_VENDOR_SOURCE_IDS = new Set([
  "github-discovery",
  "github-openseo-official",
  "github-goldmansachs-official"
]);

export function hasPersistentVendorSource(record) {
  return (record?.sources || []).some((source) => PERSISTENT_VENDOR_SOURCE_IDS.has(source));
}
