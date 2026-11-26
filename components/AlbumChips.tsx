import GroupOutlinedIcon from "@mui/icons-material/GroupOutlined"
import Chip from "@mui/material/Chip"
import Stack from "@mui/material/Stack"
import Tooltip from "@mui/material/Tooltip"
import Typography from "@mui/material/Typography"
import type { PhotoDetailsEntry } from "../lib/photo-details"

export function AlbumChips({ entry }: { entry?: PhotoDetailsEntry }) {
  if (!entry) return null
  if (entry.status === "loading") {
    return <Typography variant="caption" aria-label="Loading albums…" color="text.secondary">Loading albums…</Typography>
  }
  if (entry.status === "unavailable") {
    return (
      <Tooltip title={entry.reason}>
        <Typography variant="caption" aria-label="Album info unavailable" color="text.secondary">—</Typography>
      </Tooltip>
    )
  }

  const { albums } = entry.details
  if (albums.length === 0) {
    return <Typography variant="caption" aria-label="No albums" color="text.secondary">No albums</Typography>
  }
  return (
    <Stack direction="row" flexWrap="wrap" gap={0.5} role="group" aria-label="Albums" sx={{ minWidth: 0 }}>
      {albums.slice(0, 2).map(album => {
        const label = album.title + (album.isShared ? " (shared album)" : "")
        return (
          <Tooltip key={album.mediaKey} title={label}>
            <Chip
              size="small"
              variant="outlined"
              aria-label={label}
              icon={album.isShared ? <GroupOutlinedIcon /> : undefined}
              label={album.title}
              sx={{ maxWidth: "100%", "& .MuiChip-label": { textOverflow: "ellipsis" } }}
            />
          </Tooltip>
        )
      })}
      {albums.length > 2 && (
        <Tooltip title={albums.map(album => album.title).join(", ")}>
          <Chip size="small" variant="outlined" label={"+" + (albums.length - 2)} />
        </Tooltip>
      )}
    </Stack>
  )
}
