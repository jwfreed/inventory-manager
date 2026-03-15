import type { Reservation } from '../../../api/types'

export function getReservationStatus(reservation: Reservation | null | undefined) {
  return (reservation?.status ?? reservation?.state ?? '').toUpperCase()
}

export function canAllocateReservation(reservation: Reservation | null | undefined) {
  return getReservationStatus(reservation) === 'RESERVED'
}

export function canCancelReservation(reservation: Reservation | null | undefined) {
  const status = getReservationStatus(reservation)
  return status === 'RESERVED' || status === 'ALLOCATED'
}

export function canFulfillReservation(reservation: Reservation | null | undefined) {
  return getReservationStatus(reservation) === 'ALLOCATED'
}

export function getReservationActionGuardMessage(reservation: Reservation | null | undefined) {
  const status = getReservationStatus(reservation)
  switch (status) {
    case 'ALLOCATED':
      return {
        allocate: 'Reservation is already allocated.',
        cancel: null,
        fulfill: null,
      }
    case 'RESERVED':
      return {
        allocate: null,
        cancel: null,
        fulfill: 'Allocate the reservation before fulfilling it.',
      }
    case 'FULFILLED':
      return {
        allocate: 'Fulfilled reservations cannot be reallocated.',
        cancel: 'Fulfilled reservations cannot be canceled.',
        fulfill: 'Reservation is already fully fulfilled.',
      }
    case 'CANCELLED':
      return {
        allocate: 'Canceled reservations cannot be reactivated from the UI.',
        cancel: 'Reservation is already canceled.',
        fulfill: 'Canceled reservations cannot be fulfilled.',
      }
    case 'EXPIRED':
      return {
        allocate: 'Expired reservations must be recreated rather than reallocated.',
        cancel: 'Expired reservations are already closed.',
        fulfill: 'Expired reservations cannot be fulfilled.',
      }
    default:
      return {
        allocate: 'Reservation status does not allow allocation.',
        cancel: 'Reservation status does not allow cancellation.',
        fulfill: 'Reservation status does not allow fulfillment.',
      }
  }
}
