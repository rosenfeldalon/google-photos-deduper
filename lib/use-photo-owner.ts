import { useEffect, useState } from "react"

interface OwnerDecision {
  actorId?: string
  rejectedActorId?: string
}

export function usePhotoOwner(account: string | null) {
  const [saved, setSaved] = useState<{ account: string; decision: OwnerDecision }>()
  const key = account ? "photosOwner:" + account : undefined
  useEffect(() => {
    if (!account || !key) return
    let active = true
    const update = (value: unknown) => {
      if (!active) return
      const fields = value && typeof value === "object" ? value as OwnerDecision : {}
      setSaved({
        account,
        decision: {
          ...(typeof fields.actorId === "string" ? { actorId: fields.actorId } : {}),
          ...(typeof fields.rejectedActorId === "string" ? { rejectedActorId: fields.rejectedActorId } : {}),
        },
      })
    }
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && Object.hasOwn(changes, key)) update(changes[key].newValue)
    }
    chrome.storage.onChanged.addListener(listener)
    void chrome.storage.local.get(key).then(values => update(values[key]), () => update(undefined))
    return () => {
      active = false
      chrome.storage.onChanged.removeListener(listener)
    }
  }, [account, key])

  function choose(actorId: string, confirmed: boolean) {
    if (!key || !account) return
    const decision = confirmed ? { actorId } : { rejectedActorId: actorId }
    void chrome.storage.local.set({ [key]: decision }).catch(() => {})
  }

  return {
    ready: !!account && saved?.account === account,
    decision: saved?.account === account ? saved?.decision : undefined,
    choose,
  }
}
