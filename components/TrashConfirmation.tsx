import Button from "@mui/material/Button"
import Dialog from "@mui/material/Dialog"
import DialogActions from "@mui/material/DialogActions"
import DialogContent from "@mui/material/DialogContent"
import DialogContentText from "@mui/material/DialogContentText"
import DialogTitle from "@mui/material/DialogTitle"
import { describeSkippedTrash, type GuardedTrash } from "../lib/photo-provenance"

export interface TrashPlan extends GuardedTrash {
  account: string
  fullyTrashedGroups: number
}

export function TrashConfirmation({ plan, ready, onConfirm, onClose }: {
  plan: TrashPlan | null
  ready: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  if (!plan) return null
  const count = plan.mediaKeysToTrash.length
  const skipped = describeSkippedTrash(plan.skipped)
  return (
    <Dialog open onClose={onClose} aria-labelledby="trash-confirmation-title">
      <DialogTitle id="trash-confirmation-title">Move to Trash</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Move {count} duplicate{count !== 1 ? "s" : ""} to trash? You can restore them from Google Photos trash.
        </DialogContentText>
        {skipped && <DialogContentText sx={{ mt: 2 }}>Skipped: {skipped}.</DialogContentText>}
        {plan.sharedAlbumCount > 0 && (
          <DialogContentText sx={{ mt: 2 }}>
            Photos in shared albums may be removed for album members. {plan.sharedAlbumCount} selected.
          </DialogContentText>
        )}
        {plan.fullyTrashedGroups > 0 && (
          <DialogContentText sx={{ mt: 2 }} color="error">
            {plan.fullyTrashedGroups} {plan.fullyTrashedGroups === 1 ? "group will" : "groups will"} be removed entirely.
          </DialogContentText>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={onConfirm} disabled={!ready || count === 0} variant="contained" color="error">
          Move to Trash
        </Button>
      </DialogActions>
    </Dialog>
  )
}
