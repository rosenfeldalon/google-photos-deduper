import Alert from "@mui/material/Alert"
import Avatar from "@mui/material/Avatar"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import Checkbox from "@mui/material/Checkbox"
import Chip from "@mui/material/Chip"
import FormControlLabel from "@mui/material/FormControlLabel"
import Stack from "@mui/material/Stack"
import Tooltip from "@mui/material/Tooltip"
import Typography from "@mui/material/Typography"
import type { PhotoDetailsEntry } from "../lib/photo-details"
import { mayManuallyTrash, PROVENANCE_LABELS } from "../lib/photo-provenance"
import type { OwnerCandidate, PhotoDetailsByKey, Provenance } from "../lib/photo-provenance"
import type { GpdMediaItem } from "../lib/types"

const kinds = Object.keys(PROVENANCE_LABELS) as Provenance[]
const yesNo = (value?: boolean | null) => value === true ? "Yes" : value === false ? "No" : "Unknown"

export function ProvenanceBadge({ kind, item, entry }: {
  kind: Provenance
  item: GpdMediaItem
  entry?: PhotoDetailsEntry
}) {
  const details = entry?.status === "loaded" ? entry.details : undefined
  const evidence = [
    "Source: " + (details?.source ?? "Unknown"),
    "Owner: " + (details?.ownerName ?? "Unknown"),
    "Library marks as owned: " + yesNo(item.isOwned),
    "Saved to your Photos: " + yesNo(details?.savedToYourPhotos),
  ].join(". ")
  return (
    <Tooltip title={evidence} describeChild>
      <Chip label={PROVENANCE_LABELS[kind]} size="small" variant="outlined" sx={{ maxWidth: "100%" }} />
    </Tooltip>
  )
}

export function PhotoTrashCheckbox({ kind, checked, ready, label, onChange, disabledReason }: {
  kind: Provenance
  checked: boolean
  ready: boolean
  label: string
  onChange: () => void
  disabledReason?: string
}) {
  const allowed = ready && mayManuallyTrash(kind)
  const reason = allowed ? "" : disabledReason ??
    (ready ? "Only photos confirmed as yours can be selected." : "Photos ownership checks are incomplete.")
  return (
    <Tooltip title={reason} describeChild>
      <span>
        <FormControlLabel
          sx={{ m: 0 }}
          label={<Typography variant="caption">Move to trash</Typography>}
          control={
            <Checkbox
              size="small"
              disabled={!allowed}
              checked={allowed && checked}
              onChange={onChange}
              inputProps={{ "aria-label": "Move " + label + " to trash" }}
              sx={{ p: 0.5 }}
            />
          }
        />
      </span>
    </Tooltip>
  )
}

export function OwnerConfirmation({ candidate, reason, onConfirm, onReject }: {
  candidate?: OwnerCandidate
  reason: string
  onConfirm: () => void
  onReject: () => void
}) {
  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      <Stack spacing={1}>
        <Typography variant="body2">{reason}</Typography>
        {candidate && (
          <>
            <Stack direction="row" spacing={1} alignItems="center">
              {candidate.photoUrl && <Avatar src={candidate.photoUrl} alt="" sx={{ width: 32, height: 32 }} />}
              <Box>
                <Typography variant="body2" fontWeight={600}>
                  {candidate.name ?? "Unnamed Photos owner"}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Matches {candidate.count} of {candidate.samples} photos marked owned.
                </Typography>
              </Box>
            </Stack>
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="outlined" onClick={onConfirm}>Confirm owner</Button>
              <Button size="small" onClick={onReject}>Not me</Button>
            </Stack>
          </>
        )}
      </Stack>
    </Alert>
  )
}

export function ProvenanceSummary({ items, kinds: classifications, details }: {
  items: GpdMediaItem[]
  kinds: ReadonlyMap<string, Provenance>
  details: PhotoDetailsByKey
}) {
  const counts = new Map<Provenance, number>()
  const sources = new Map<string, number>()
  const samples = new Map<Provenance, GpdMediaItem[]>()
  for (const item of items) {
    const kind = classifications.get(item.mediaKey) ?? "unknown"
    const entry = details.get(item.mediaKey)
    const source = (entry?.status === "loaded" && entry.details.source) || "Unavailable"
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    sources.set(source, (sources.get(source) ?? 0) + 1)
    const rows = samples.get(kind) ?? []
    if (rows.length < 5) {
      rows.push(item)
      samples.set(kind, rows)
    }
  }
  return (
    <Box component="details" sx={{ my: 2 }}>
      <Typography component="summary" variant="body2" fontWeight={600} sx={{ cursor: "pointer" }}>
        Review photo ownership
      </Typography>
      <Stack spacing={1} sx={{ py: 1 }}>
        <Typography variant="body2">Photos in this scan</Typography>
        <Stack direction="row" flexWrap="wrap" gap={1}>
          {kinds.map(kind => (
            <Typography key={kind} variant="caption">{PROVENANCE_LABELS[kind]}: {counts.get(kind) ?? 0}</Typography>
          ))}
        </Stack>
        <Stack direction="row" flexWrap="wrap" gap={1}>
          {[...sources].map(([source, count]) => (
            <Typography key={source} variant="caption">{source}: {count}</Typography>
          ))}
        </Stack>
        {kinds.map(kind => {
          const rows = samples.get(kind)
          if (!rows?.length) return null
          return (
            <Box key={kind}>
              <Typography variant="body2" fontWeight={600}>{PROVENANCE_LABELS[kind]} samples</Typography>
              <Box component="ul" sx={{ my: 0, pl: 2 }}>
                {rows.map(item => {
                  const entry = details.get(item.mediaKey)
                  const evidence = entry?.status === "loaded" ? entry.details : undefined
                  return (
                    <Typography key={item.mediaKey} component="li" variant="caption">
                      {item.fileName || "Unnamed photo"} · {evidence?.source ?? "Unknown source"} · {evidence?.ownerName ?? "Unknown owner"}
                      {" · Library owned: " + yesNo(item.isOwned) + " · Saved: " + yesNo(evidence?.savedToYourPhotos)}
                    </Typography>
                  )
                })}
              </Box>
            </Box>
          )
        })}
      </Stack>
    </Box>
  )
}
