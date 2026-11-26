import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { AlbumChips } from "../../components/AlbumChips"

describe("AlbumChips", () => {
  it.each([
    ["loading", { status: "loading" } as const, "Loading albums…"],
    ["none", { status: "loaded", details: { albums: [] } } as const, "No albums"],
    ["unavailable", { status: "unavailable", reason: "Missing album data" } as const, "Album info unavailable"],
  ])("renders %s distinctly", (_name, entry, label) => {
    render(<AlbumChips entry={entry} />)
    expect(screen.getByLabelText(label)).toBeVisible()
  })

  it.each([1, 2, 5])("shows up to two of %i album names and marks shared albums", count => {
    const title = "A long album name that should truncate inside a photo card at narrow widths"
    render(<AlbumChips entry={{
      status: "loaded",
      details: { albums: Array.from({ length: count }, (_, i) => ({
        mediaKey: "a" + i, title: i === 0 ? title : "Album " + i, isShared: i === 0,
      })) },
    }} />)
    const albums = screen.getByRole("group", { name: "Albums" })
    expect(within(albums).getByText(title)).toHaveStyle({ textOverflow: "ellipsis" })
    expect(within(albums).getByLabelText(title + " (shared album)")).toBeVisible()
    if (count > 1) expect(within(albums).getByText("Album 1")).toBeVisible()
    if (count > 2) {
      expect(within(albums).getByText("+3")).toBeVisible()
      expect(within(albums).queryByText("Album 2")).not.toBeInTheDocument()
    }
  })
})
