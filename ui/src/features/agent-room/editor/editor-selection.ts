import { gridToPixel, ROOM_STATIONS, type RoomLayout, type RoomStation } from "../layout"
import { roomFurnitureBounds, roomPetBounds } from "../renderer"

export type FurnitureList = "furniture" | "wallDecor"

export type Selection =
  | { kind: "furniture"; list: FurnitureList; index: number }
  | { kind: "rug"; index: number }
  | { kind: "station"; station: RoomStation }
  | { kind: "pet"; index: number }

export function hitSelections(layout: RoomLayout, x: number, y: number): Selection[] {
  const hits: Selection[] = []
  for (const station of ROOM_STATIONS) {
    const selection: Selection = { kind: "station", station }
    const bounds = selectionBounds(layout, selection)
    if (bounds && contains(bounds, x, y)) hits.push(selection)
  }
  for (let index = layout.pets.length - 1; index >= 0; index -= 1)
    if (contains(roomPetBounds(layout.pets[index]), x, y)) hits.push({ kind: "pet", index })
  for (let index = layout.furniture.length - 1; index >= 0; index -= 1)
    if (contains(roomFurnitureBounds(layout.furniture[index]), x, y))
      hits.push({ kind: "furniture", list: "furniture", index })
  for (let index = layout.wallDecor.length - 1; index >= 0; index -= 1)
    if (contains(roomFurnitureBounds(layout.wallDecor[index]), x, y))
      hits.push({ kind: "furniture", list: "wallDecor", index })
  for (let index = layout.rugs.length - 1; index >= 0; index -= 1) {
    const selection: Selection = { kind: "rug", index }
    const bounds = selectionBounds(layout, selection)
    if (bounds && contains(bounds, x, y)) hits.push(selection)
  }
  return hits
}

export function selectionBounds(layout: RoomLayout, selection: Selection) {
  if (selection.kind === "furniture") {
    const item = layout[selection.list][selection.index]
    return item ? roomFurnitureBounds(item) : undefined
  }
  if (selection.kind === "pet")
    return layout.pets[selection.index] ? roomPetBounds(layout.pets[selection.index]) : undefined
  if (selection.kind === "rug") {
    const rug = layout.rugs[selection.index]
    return rug
      ? {
          x: gridToPixel(rug.x),
          y: gridToPixel(rug.y),
          width: gridToPixel(rug.width),
          height: gridToPixel(rug.height),
        }
      : undefined
  }
  const station = layout.stations[selection.station]
  const x = gridToPixel(station.x)
  const y = gridToPixel(station.y)
  return { x: x - 8, y: y - 8, width: 16, height: 16 }
}

export function selectionPosition(
  layout: RoomLayout,
  selection: Selection
): { x: number; y: number } | undefined {
  if (selection.kind === "station") return layout.stations[selection.station]
  if (selection.kind === "rug") return layout.rugs[selection.index]
  if (selection.kind === "pet") return layout.pets[selection.index]
  return layout[selection.list][selection.index]
}

export function selectionLabel(layout: RoomLayout, selection: Selection): string {
  if (selection.kind === "station") return `${layout.stations[selection.station].label} station`
  if (selection.kind === "rug") return `Rug ${selection.index + 1}`
  if (selection.kind === "pet")
    return `Pet · ${layout.pets[selection.index]?.asset.split("/").at(-2) ?? "unknown"}`
  const item = layout[selection.list][selection.index]
  return `${item?.asset.split("/").at(-1) ?? "Item"} · ${selection.list === "wallDecor" ? "wall" : "furniture"}`
}

export function selectionKey(selection: Selection): string {
  if (selection.kind === "station") return `station:${selection.station}`
  if (selection.kind === "pet") return `pet:${selection.index}`
  return `${selection.kind}:${"list" in selection ? `${selection.list}:` : ""}${selection.index}`
}

export function sameSelection(left: Selection, right: Selection): boolean {
  return selectionKey(left) === selectionKey(right)
}

function contains(
  bounds: { x: number; y: number; width: number; height: number },
  x: number,
  y: number
): boolean {
  return (
    x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height
  )
}
