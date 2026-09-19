/* Exact remaining-card runout enumeration. Display only; PokerKit settles hands.
 * Cards are rank * 4 + suit (rank 0 = deuce, 12 = ace).
 * Dead cards include all already used cards, never the future deck order.
 */
#include <stdint.h>
#include <string.h>

static unsigned straight(unsigned mask) {
    unsigned runs = mask & (mask >> 1) & (mask >> 2) & (mask >> 3) & (mask >> 4);
    if (runs) return 31u - (unsigned)__builtin_clz(runs) + 6u;
    return (mask & 0x100fu) == 0x100fu ? 5u : 0u;
}
static unsigned top(unsigned mask, int n) {
    unsigned value = 0;
    while (n-- > 0 && mask) {
        unsigned bit = 31u - (unsigned)__builtin_clz(mask);
        value = (value << 4) | (bit + 2u);
        mask ^= 1u << bit;
    }
    return value;
}
static uint32_t rank7(const int *cards) {
    unsigned suits[4] = {0}, counts[13] = {0}, mask = 0;
    for (int i = 0; i < 7; ++i) {
        unsigned r = (unsigned)cards[i] / 4, s = (unsigned)cards[i] % 4;
        ++counts[r]; suits[s] |= 1u << r; mask |= 1u << r;
    }
    unsigned flush = 0;
    for (int s = 0; s < 4; ++s) if (__builtin_popcount(suits[s]) >= 5) {
        unsigned high = straight(suits[s]);
        if (high) return (8u << 24) | high;
        flush = suits[s];
    }
    unsigned pairs = 0, trips = 0;
    for (int r = 12; r >= 0; --r) {
        if (counts[r] == 4) return (7u << 24) | ((unsigned)(r + 2) << 4) | top(mask ^ (1u << r), 1);
        if (counts[r] >= 3) trips |= 1u << r;
        if (counts[r] >= 2) pairs |= 1u << r;
    }
    unsigned trip = trips ? 31u - (unsigned)__builtin_clz(trips) : 0;
    if (trips && (pairs & ~(1u << trip)))
        return (6u << 24) | ((trip + 2u) << 4) | top(pairs & ~(1u << trip), 1);
    if (flush) return (5u << 24) | top(flush, 5);
    unsigned high = straight(mask);
    if (high) return (4u << 24) | high;
    if (trips) return (3u << 24) | ((trip + 2u) << 8) | top(mask & ~(1u << trip), 2);
    if (__builtin_popcount(pairs) >= 2) {
        unsigned two = top(pairs, 2);
        unsigned used = (1u << ((two >> 4) - 2)) | (1u << ((two & 15) - 2));
        return (2u << 24) | (two << 4) | top(mask & ~used, 1);
    }
    if (pairs) return (1u << 24) | (top(pairs, 1) << 12) | top(mask & ~pairs, 3);
    return top(mask, 5);
}
uint32_t rr_rank7(const int *cards) { return rank7(cards); }

typedef struct {
    const int *holes;
    int players, remaining[52], remaining_count, cards[7];
    uint64_t total, wins[9];
} Enumeration;
static void visit(Enumeration *ctx) {
    uint32_t best = 0;
    int winner = -1;
    for (int p = 0; p < ctx->players; ++p) {
        ctx->cards[5] = ctx->holes[p * 2]; ctx->cards[6] = ctx->holes[p * 2 + 1];
        uint32_t value = rank7(ctx->cards);
        if (value > best) { best = value; winner = p; }
        else if (value == best) winner = -1;
    }
    ++ctx->total;
    if (winner >= 0) ++ctx->wins[winner];
}
static void enumerate(Enumeration *ctx, int position, int begin) {
    if (position == 5) { visit(ctx); return; }
    for (int i = begin; i <= ctx->remaining_count - (5 - position); ++i) {
        ctx->cards[position] = ctx->remaining[i];
        enumerate(ctx, position + 1, i + 1);
    }
}
uint64_t rr_count(const int *holes, int players, const int *board, int board_count,
                  const int *dead, int dead_count, uint64_t *wins) {
    Enumeration ctx = {.holes = holes, .players = players};
    uint64_t used = 0;
    for (int i = 0; i < players * 2; ++i) used |= (uint64_t)1 << holes[i];
    for (int i = 0; i < board_count; ++i) { used |= (uint64_t)1 << board[i]; ctx.cards[i] = board[i]; }
    for (int i = 0; i < dead_count; ++i) used |= (uint64_t)1 << dead[i];
    for (int c = 0; c < 52; ++c) if (!(used & ((uint64_t)1 << c))) ctx.remaining[ctx.remaining_count++] = c;
    enumerate(&ctx, board_count, 0);
    memcpy(wins, ctx.wins, sizeof(uint64_t) * players);
    return ctx.total;
}
