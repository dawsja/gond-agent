export const PINNED_DISTANCE = 80
export const SHOW_DISTANCE = 120

/** Keep the previous decision in the gap so streaming cannot flicker the control. */
export function showScrollToBottom(distance: number, shown: boolean, hideAt = PINNED_DISTANCE, showAfter = SHOW_DISTANCE): boolean {
  return distance <= hideAt ? false : distance > showAfter ? true : shown
}

// Preserve the transcript's original strict 80px follow threshold.
export function isPinned(distance: number): boolean {
  return distance < PINNED_DISTANCE
}
