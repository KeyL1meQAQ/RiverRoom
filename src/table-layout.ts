export const SEAT_COUNT = 10;

// Actual seats keep their clockwise order; diagram numbers are visual slots.
export const desktopPositions = [
  [62, 88], [38, 88], [18, 72], [11, 50], [18, 28],
  [38, 12], [62, 12], [82, 28], [89, 50], [82, 72],
];
// Vertical anchors keep player groups compact while taller screens gain central space.
export const mobilePositions: [number, string][] = [
  [50, 'calc(100% - 28px)'], [15, 'calc(100% - 91px)'], [15, 'calc(100% - 189px)'],
  [15, '216px'], [15, '112px'], [50, '68px'],
  [85, '112px'], [85, '216px'], [85, 'calc(100% - 189px)'], [85, 'calc(100% - 91px)'],
];

export function relativeSeat(seat: number, ownSeat: number) {
  return (seat - ownSeat + SEAT_COUNT) % SEAT_COUNT;
}
