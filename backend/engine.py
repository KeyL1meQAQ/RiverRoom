"""PokerKit adapter: deterministic replay and room-specific split-pot policy."""
from collections import deque
import secrets

from pokerkit import Automation, Card, Deck, Mode, NoLimitTexasHoldem

AUTOMATIONS = (Automation.ANTE_POSTING, Automation.BLIND_OR_STRADDLE_POSTING, Automation.BET_COLLECTION)


def new_hand(ids, seats, stacks, blinds, big_blind, number):
    deck = list(Deck.STANDARD)
    secrets.SystemRandom().shuffle(deck)
    return dict(number=number, ids=ids, seats=seats, initial=stacks, blinds=blinds,
                big_blind=big_blind, deck=[repr(c) for c in deck], ops=[], dealt={},
                revealed=[], shown_cards={}, showdown_order=[], reveal_version=1,
                votes={}, runouts=None, awards=[], result=None,
                action_seq=0, clock=None, last_actions={})


def state_for(hand):
    state = NoLimitTexasHoldem.create_state(AUTOMATIONS, True, 0, hand['blinds'],
        hand['big_blind'], hand['initial'], len(hand['ids']), mode=Mode.CASH_GAME)
    state.deck_cards = deque(Card.parse(''.join(hand['deck'])))
    for name, args in hand['ops']:
        perform(state, name, args)
    return state


def perform(state, name, args):
    if name != 'push_chips':
        return getattr(state, name)(*args)
    pots = list(state.pots)
    op = state.push_chips()
    # PokerKit awards the entire tie remainder to one player; our table
    # distributes one chip each clockwise, with engine indices left of button.
    if op.board_index is not None:
        hands = list(state.get_up_hands(op.board_index, 0))
        eligible = pots[op.pot_index].player_indices
        best = max(hands[i] for i in eligible if hands[i] is not None)
        winners = [i for i in eligible if hands[i] == best]
        q, rem = divmod(sum(op.amounts), len(winners))
        corrected = [0] * state.player_count
        for rank, i in enumerate(winners):
            corrected[i] = q + (rank < rem)
        for i, amount in enumerate(corrected):
            state.bets[i] += amount - op.amounts[i]
        return dict(amounts=corrected, pot=op.pot_index, board=op.board_index, winners=winners)
    hands = list(state.get_up_hands(0, 0))
    eligible = [i for i in pots[op.pot_index].player_indices if hands[i] is not None]
    best = max((hands[i] for i in eligible), default=None)
    winners = [i for i in eligible if hands[i] == best] if best else []
    return dict(amounts=list(op.amounts), pot=op.pot_index, board=None, winners=winners)


def step(hand, state, name, *args):
    op = perform(state, name, list(args))
    hand['ops'].append([name, list(args)])
    if name == 'deal_hole':
        for i, cards in enumerate(state.hole_cards):
            if cards:
                hand['dealt'][hand['ids'][i]] = [repr(c) for c in cards]
    if name == 'push_chips':
        hand['awards'].append(op)
    return op


def advance(hand, state, allow_twice, pause_on_board=False):
    for _ in range(300):
        if not state.status:
            return 'finished'
        if state.actor_index is not None:
            return 'betting'
        selectors = list(state.runout_count_selector_indices)
        if selectors:
            hand.setdefault('runout_prefix', len(list(state.get_board_cards(0))))
            hand['revealed'] = [hand['ids'][i] for i, active in enumerate(state.statuses) if active]
            if allow_twice and hand['runouts'] is None:
                return 'runout'
            count = hand['runouts'] or 1
            step(hand, state, 'select_runout_count', count)
        elif state.can_burn_card():
            step(hand, state, 'burn_card')
        elif state.can_deal_hole():
            step(hand, state, 'deal_hole')
        elif state.can_deal_board():
            step(hand, state, 'deal_board')
            if pause_on_board:
                return 'dealing'
        elif state.can_show_or_muck_hole_cards():
            if not hand.get('showdown_order'):
                hand['showdown_order'] = [hand['ids'][i] for i in state.showdown_indices]
            if state.all_in_status:
                hand['revealed'] = [hand['ids'][i] for i, active in enumerate(state.statuses) if active]
            step(hand, state, 'show_or_muck_hole_cards', True)
        elif state.can_kill_hand():
            step(hand, state, 'kill_hand')
        elif state.can_push_chips():
            step(hand, state, 'push_chips')
        elif state.can_pull_chips():
            step(hand, state, 'pull_chips')
        else:
            raise RuntimeError('Poker engine is in an unsupported state')
    raise RuntimeError('Poker engine exceeded the transition limit')


def boards(state):
    return [[repr(c) for c in state.get_board_cards(i)] for i in state.board_indices]


def legal(state):
    return dict(fold=state.can_fold(), call=state.checking_or_calling_amount or 0,
                can_call=state.can_check_or_call(), can_raise=state.can_complete_bet_or_raise_to(),
                min_raise=state.min_completion_betting_or_raising_to_amount,
                max_raise=state.max_completion_betting_or_raising_to_amount)
