"""Presentation of PokerKit hand values; never a separate ranking engine."""
from collections import Counter
from functools import lru_cache

from pokerkit import Label, StandardHighHand

RANKS = '23456789TJQKA'
LABELS = {
    Label.HIGH_CARD: '高牌', Label.ONE_PAIR: '一对', Label.TWO_PAIR: '两对',
    Label.THREE_OF_A_KIND: '三条', Label.STRAIGHT: '顺子', Label.FLUSH: '同花',
    Label.FULL_HOUSE: '葫芦', Label.FOUR_OF_A_KIND: '四条', Label.STRAIGHT_FLUSH: '同花顺',
}


@lru_cache(maxsize=8192)
def describe(holes, board):
    # Board-first tie selection keeps a playable board highlighted on its own.
    best = StandardHighHand.from_game_or_none(''.join(board), ''.join(holes))
    cards = tuple(repr(c) for c in best.cards) if best else board + holes
    counts = Counter(c[0] for c in cards)
    ranked = sorted(counts, key=RANKS.index, reverse=True)
    if best:
        label = best.entry.label
    else:
        peak = max(counts.values())
        label = (Label.FOUR_OF_A_KIND if peak == 4 else Label.THREE_OF_A_KIND if peak == 3
                 else Label.TWO_PAIR if list(counts.values()).count(2) == 2
                 else Label.ONE_PAIR if peak == 2 else Label.HIGH_CARD)
    name = LABELS[label]
    if label == Label.STRAIGHT_FLUSH and set(counts) == set('TJQKA'):
        name = '皇家同花顺'
    elif label == Label.HIGH_CARD:
        name += f'[{ranked[0]}]'
    elif label in (Label.ONE_PAIR, Label.TWO_PAIR, Label.THREE_OF_A_KIND, Label.FOUR_OF_A_KIND):
        count = {Label.ONE_PAIR: 2, Label.TWO_PAIR: 2, Label.THREE_OF_A_KIND: 3, Label.FOUR_OF_A_KIND: 4}[label]
        name += '[' + ','.join(r for r in ranked if counts[r] == count) + ']'
    return name, cards


def own_labels(hand, viewer):
    holes = tuple(hand['dealt'].get(viewer, []))
    if len(holes) != 2:
        return []
    return [[describe(holes, tuple(board[:count]))[0] for count in range(len(board) + 1)]
            for board in hand.get('boards', [[]])]


def showdown_results(hand):
    if not any(name == 'show_or_muck_hole_cards' for name, _ in hand['ops']):
        return []
    groups = {}
    awards = []
    for award in hand['awards']:
        if award['board'] is None and len(hand.get('boards', [])) == 2:
            # A sole surviving winner may receive both runouts in one push.
            for board_index in range(2):
                awards.append({**award, 'board': board_index,
                               'amounts': [amount // 2 + (amount % 2 if board_index == 0 else 0)
                                           for amount in award['amounts']]})
        else:
            awards.append(award)
    for award in awards:
        board_index = award['board'] if award['board'] is not None else 0
        board = hand.get('boards', [[]])[board_index]
        if len(board) != 5:
            continue
        key = (board_index, award['pot'])
        group = groups.setdefault(key, dict(board=board_index, pot=award['pot'], winners=[]))
        winners = award.get('winners', [i for i, amount in enumerate(award['amounts']) if amount])
        for i in winners:
            pid = hand['ids'][i]
            # Historical records must obey the original public-card boundary.
            if pid not in hand['revealed']:
                continue
            label, cards = describe(tuple(hand['dealt'][pid]), tuple(board))
            previous = next((w for w in group['winners'] if w['pid'] == pid), None)
            if previous:
                previous['amount'] += award['amounts'][i]
            else:
                group['winners'].append(dict(pid=pid, amount=award['amounts'][i], label=label, cards=list(cards)))
    return [groups[key] for key in sorted(groups) if groups[key]['winners']]
