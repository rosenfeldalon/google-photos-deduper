import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { OwnerConfirmation, ProvenanceBadge, ProvenanceSummary, PhotoTrashCheckbox } from "../../components/PhotoProvenance"
import { TrashConfirmation } from "../../components/TrashConfirmation"
import { guardTrashSelection, type Provenance } from "../../lib/photo-provenance"
import type { GpdMediaItem } from "../../lib/types"

const item: GpdMediaItem = {
  mediaKey: "photo", dedupKey: "dedup", thumb: "", timestamp: 0, creationTimestamp: 0,
  isOwned: true, fileName: "fixture.jpg",
}
const candidate = { actorId: "self", name: "Fixture Owner", count: 19, samples: 20 }

describe("photo provenance controls", () => {
  it.each([
    ["mine", "Mine"], ["mine-in-shared-album", "Mine, in shared album"],
    ["partner", "Partner"], ["shared", "Shared"], ["unknown", "Unknown"],
  ] as const)("shows the %s classification", (kind, label) => {
    render(<ProvenanceBadge kind={kind} item={item} />)
    expect(screen.getByText(label)).toBeVisible()
  })

  it.each(["partner", "shared", "unknown"] as const)("protects %s in the control and command guard", kind => {
    const onChange = vi.fn()
    const details = kind === "unknown" ? undefined : {
      status: "loaded" as const,
      details: { albums: [], ownerActorId: "other", source: kind === "partner" ? "partnerShared" : "shared" },
    }
    render(<PhotoTrashCheckbox kind={kind} checked={false} ready label="fixture.jpg" onChange={onChange} />)
    const checkbox = screen.getByRole("checkbox", { name: "Move fixture.jpg to trash" })
    expect(checkbox).toBeDisabled()
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    expect(onChange).not.toHaveBeenCalled()
    expect(guardTrashSelection(["photo"], { photo: item }, new Map(details ? [["photo", details]] : []), "self", new Set(["photo"])))
      .toMatchObject({ dedupKeys: [], mediaKeysToTrash: [], skipped: { protected: 1 } })
  })

  it("allows individual selection of an owned shared-album photo", () => {
    const onChange = vi.fn()
    render(<PhotoTrashCheckbox kind="mine-in-shared-album" checked={false} ready label="fixture.jpg" onChange={onChange} />)
    const checkbox = screen.getByRole("checkbox", { name: "Move fixture.jpg to trash" })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    expect(onChange).toHaveBeenCalledOnce()
  })

  it("offers explicit owner confirmation and rejection", () => {
    const confirm = vi.fn()
    const reject = vi.fn()
    render(<OwnerConfirmation candidate={candidate} onConfirm={confirm} onReject={reject} reason="Confirm ownership to enable trash." />)
    expect(screen.getByText(/Fixture Owner/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /Confirm owner/i }))
    fireEvent.click(screen.getByRole("button", { name: "Not me" }))
    expect(confirm).toHaveBeenCalledOnce()
    expect(reject).toHaveBeenCalledOnce()
  })

  it("shows the final guarded photo count plus explicit shared-album and skipped counts", () => {
    const plan = {
      account: "fixture@example.test", dedupKeys: ["same-key"], mediaKeysToTrash: ["a", "b"],
      fullyTrashedGroups: 0, sharedAlbumCount: 1, skipped: { protected: 1, shared: 0, ambiguous: 2 },
    }
    render(<TrashConfirmation plan={plan} ready onConfirm={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText(/Move 2 duplicates to trash/)).toBeVisible()
    expect(screen.getByText(/1 with unverified ownership, 2 with ambiguous dedup keys/)).toBeVisible()
    expect(screen.getByText(/may be removed for album members/)).toBeVisible()
  })

  it("shows counts, source, and limited evidence in the review summary", () => {
    const other = { ...item, mediaKey: "another", fileName: "another.jpg" }
    const kinds = new Map<string, Provenance>([["photo", "mine"], ["another", "unknown"]])
    const entries = new Map([["photo", { status: "loaded" as const, details: { albums: [], source: "mobile", ownerName: "Fixture Owner" } }]])
    render(<ProvenanceSummary items={[item, other]} kinds={kinds} details={entries} />)
    expect(screen.getByText("Mine: 1")).toBeInTheDocument()
    expect(screen.getByText("Unknown: 1")).toBeInTheDocument()
    expect(screen.getByText("mobile: 1")).toBeInTheDocument()
    expect(screen.getByText(/fixture\.jpg/)).toBeInTheDocument()
  })
})
