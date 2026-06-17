// Whether this Composery belongs to a Composery Cloud account, and where it calls
// home. Kept apart from the cloud routes so page rendering and password policy
// can ask the same question without importing a router.
type CloudConfig = {
  boxId: string
  origin: string
}

function readCloudConfig(): CloudConfig | undefined {
  const boxId = process.env.COMPOSERY_CLOUD_BOX_ID?.trim()
  const rawOrigin = process.env.COMPOSERY_CLOUD_ORIGIN?.trim()
  if (!boxId && !rawOrigin) return undefined
  if (!boxId || !rawOrigin) {
    throw new Error("COMPOSERY_CLOUD_BOX_ID and COMPOSERY_CLOUD_ORIGIN must be configured together")
  }
  const origin = new URL(rawOrigin)
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("COMPOSERY_CLOUD_ORIGIN must be an HTTPS origin")
  }
  return { boxId, origin: origin.origin }
}

export const cloudConfig = readCloudConfig()
