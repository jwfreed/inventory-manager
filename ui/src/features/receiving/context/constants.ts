import type { ReceiptLineInput } from '../types'

export const DISCREPANCY_LABELS: Record<ReceiptLineInput['discrepancyReason'], string> = {
  '': 'No variance',
  short: 'Short',
  over: 'Over',
  damaged: 'Damaged',
  substituted: 'Substituted',
}

export const RECEIPT_ERROR_MAP: Record<string, string> = {
  'Purchase order is already fully received/closed.':
    'This PO is already received/closed. Create a receipt on a different PO.',
  'Receipt line UOM must match the purchase order line UOM.':
    'Use the same UOM as the PO line for each receipt line.',
  'One or more purchase order lines were not found.':
    'One or more PO lines are invalid. Re-select the PO lines and try again.',
  'All receipt lines must reference the provided purchase order.':
    'Each receipt line must belong to the selected PO.',
  'Discrepancy reason is required when received quantity differs from expected.':
    'Select a discrepancy reason for each line that differs from expected.',
}

export const QC_ERROR_MAP: Record<string, string> = {
  'Receipt line not found.':
    'That receipt line could not be found. Reload the receipt and try again.',
  'QC event UOM must match the receipt line UOM.':
    'UOM mismatch. QC events must use the receipt line UOM.',
  'QC quantities cannot exceed the received quantity for the line.':
    'Quantity exceeds the remaining allocable quantity for this line.',
  'Referenced receipt line does not exist.':
    'That receipt line no longer exists. Reload the receipt and try again.',
  'QC quantity must be greater than zero.':
    'Enter a quantity greater than zero.',
  'Receipt line has no receiving location to post accepted inventory.':
    'Set a receiving/staging location on the PO before recording acceptance.',
  'Receipt is voided; QC events are not allowed.':
    'This receipt is voided. QC events are locked.',
}

export const PUTAWAY_CREATE_ERROR_MAP: Record<string, string> = {
  'Source and destination locations must differ.':
    'Pick a different To location than the From location for each line.',
  'Putaway line UOM must match the receipt line UOM.':
    'Use the same UOM as the receipt line.',
  'fromLocationId is required when the receipt lacks a staging location.':
    'Select a From location for each line (staging/receiving).',
  'QC hold or missing acceptance prevents planning this putaway.':
    'This receipt line is on QC hold or has no accepted quantity. Resolve QC before planning putaway.',
  'Requested quantity exceeds available putaway quantity.':
    'Reduce the quantity to the remaining available amount.',
  'purchaseOrderReceiptId is required for receipt-based putaways.':
    'Select a receipt before creating a putaway.',
  'One or more receipt lines were not found.':
    'One or more receipt lines are invalid. Reload the receipt and try again.',
  'Receipt is voided; putaway cannot be created.':
    'This receipt is voided. Putaway is locked.',
}

export const PUTAWAY_POST_ERROR_MAP: Record<string, string> = {
  'Putaway already posted.':
    'This putaway was already posted. No additional changes were made.',
  'Putaway line quantity must be greater than zero before posting.':
    'Each line must have a positive quantity before posting.',
  'Putaway has no lines to post.':
    'Add at least one line before posting.',
  'All putaway lines are already completed or canceled.':
    'Nothing left to post for this putaway.',
  'QC hold or missing acceptance prevents posting this putaway.':
    'QC hold is blocking posting. Resolve QC and try again.',
  'Putaway quantity exceeds available accepted quantity.':
    'Reduce quantities or record QC acceptance before posting.',
  'Requested putaway quantity exceeds accepted quantity.':
    'Reduce quantities or record QC acceptance before posting.',
  'Receipt is voided; putaway cannot be posted.':
    'This receipt is voided. Putaway is locked.',
}
