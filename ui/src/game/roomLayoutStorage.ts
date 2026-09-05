import { useEffect, useState } from "react"

import { cloneDefaultRoomLayout, migrateRoomLayout, type RoomLayout } from "./agentRoomLayout"

const STORAGE_KEY = "shellby-room-layout-v1"
const CHANGE_EVENT = "shellby-room-layout-changed"

export function loadRoomLayout(): RoomLayout {
  const saved = window.localStorage.getItem(STORAGE_KEY)
  if (!saved) return cloneDefaultRoomLayout()
  try {
    return migrateRoomLayout(JSON.parse(saved) as Partial<RoomLayout>)
  } catch {
    return cloneDefaultRoomLayout()
  }
}

export function saveRoomLayout(layout: RoomLayout): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function clearSavedRoomLayout(): void {
  window.localStorage.removeItem(STORAGE_KEY)
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function useRoomLayout(): RoomLayout {
  const [layout, setLayout] = useState(loadRoomLayout)

  useEffect(() => {
    const reload = () => setLayout(loadRoomLayout())
    window.addEventListener("storage", reload)
    window.addEventListener(CHANGE_EVENT, reload)
    return () => {
      window.removeEventListener("storage", reload)
      window.removeEventListener(CHANGE_EVENT, reload)
    }
  }, [])

  return layout
}
