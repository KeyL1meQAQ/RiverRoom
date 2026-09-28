export const SEAT_COUNT = 10;

// Actual seats keep their clockwise order; diagram numbers are visual slots.
export const desktopPositions = [
  [62, 88], [38, 88], [18, 72], [11, 50], [18, 28],
  [38, 12], [62, 12], [82, 28], [89, 50], [82, 72],
];
export const mobilePositions = [
  [50, 95], [15, 82], [15, 69], [15, 36], [15, 23],
  [50, 10], [85, 23], [85, 36], [85, 69], [85, 82],
];

export function relativeSeat(seat: number, ownSeat: number) {
  return (seat - ownSeat + SEAT_COUNT) % SEAT_COUNT;
}
