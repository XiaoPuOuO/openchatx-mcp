interface PixelAgentsFurnitureCatalogEntry {
  id: string
  label: string
  category: string
  path: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  orientation: string | null
  state: string | null
  mirrorSide: boolean
  canPlaceOnWalls: boolean
  canPlaceOnSurfaces: boolean
  backgroundTiles: number
}

interface PixelAgentsImageCatalogEntry {
  kind: string
  path: string
}

interface PixelAgentsSimpleCatalogEntry {
  id: string
  label: string
  path: string
}

export interface PixelAgentsCatalog {
  version: number
  upstream: { repository: string; commit: string }
  furniture: PixelAgentsFurnitureCatalogEntry[]
  floors: PixelAgentsSimpleCatalogEntry[]
  walls: PixelAgentsSimpleCatalogEntry[]
  carpets: PixelAgentsSimpleCatalogEntry[]
  characters: PixelAgentsSimpleCatalogEntry[]
  pets: PixelAgentsSimpleCatalogEntry[]
  images: PixelAgentsImageCatalogEntry[]
}

export async function fetchPixelAgentsCatalog(): Promise<PixelAgentsCatalog> {
  const response = await fetch("/ui/pixel-agents/catalog.json")
  if (!response.ok) throw new Error(`Failed to load Pixel Agents catalog (${response.status})`)
  return (await response.json()) as PixelAgentsCatalog
}
