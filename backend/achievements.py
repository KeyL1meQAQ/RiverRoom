"""Room-scoped achievements, derived only from completed hand results."""
import logging

from . import engine

logger = logging.getLogger('river')
VERSION = 1
METRICS = ('wins', 'busts')


def initialize(room):
    room.update(achievement_version=VERSION, achievement_hand=0,
                achievement_since={metric: 1 for metric in METRICS})
    for player in room['players'].values():
        player['achievements'] = dict(wins=0, busts=0)


def main_winner(hand):
    awards = hand['awards']
    if any('winners' not in award for award in awards):
        # Legacy amounts alone cannot distinguish a tie with zero-chip winners.
        replay = dict(hand, ops=[])
        state = engine.state_for(replay)
        awards = []
        for name, args in hand['ops']:
            operation = engine.perform(state, name, args)
            if name == 'push_chips':
                awards.append(operation)
        if state.status or not awards:
            raise ValueError('Incomplete historical replay')
    main = [award for award in awards if award['pot'] == 0]
    if not main:
        raise ValueError('Missing main pot')
    expected = set(range(hand.get('runouts') or 1))
    covered = set()
    winners = []
    for award in main:
        board = award['board']
        if board is None:
            # A single surviving hand can receive both runouts in one award.
            if len(main) != 1:
                raise ValueError('Ambiguous main pot boards')
            covered.update(expected)
        else:
            if board in covered or board not in expected:
                raise ValueError('Invalid main pot board')
            covered.add(board)
        indices = award['winners']
        if not indices:
            # Folding wins have no evaluated hand, hence an empty winners list.
            folded = hand.get('folded')
            if folded is None:
                folded = engine.folded_players(hand)
            remaining = [i for i, pid in enumerate(hand['ids']) if pid not in folded]
            recipients = [i for i, amount in enumerate(award['amounts']) if amount > 0]
            if len(remaining) != 1 or remaining != recipients:
                raise ValueError('Missing winner identity')
            indices = remaining
        winners.append(hand['ids'][indices[0]] if len(indices) == 1 else None)
    if covered != expected:
        raise ValueError('Incomplete main pot boards')
    return winners[0] if winners[0] is not None and all(w == winners[0] for w in winners) else None


def busted_players(hand):
    results = {result['pid']: result['delta'] for result in hand['result']}
    ids, initial = hand['ids'], hand['initial']
    if len(initial) != len(ids) or set(results) != set(ids):
        raise ValueError('Incomplete settlement')
    busted = []
    for pid, start in zip(ids, initial):
        end = start + results[pid]
        if type(start) is not int or type(end) is not int or start <= 0 or end < 0:
            raise ValueError('Invalid settlement stack')
        if end == 0:
            busted.append(pid)
    return busted


def reset_metric(room, metric, since):
    # Keep a contiguous, explainable suffix instead of silently skipping holes.
    room['achievement_since'][metric] = since
    for player in room['players'].values():
        player['achievements'][metric] = 0


def record(room, hand, historical=False):
    number = hand['number']
    if hand.get('result') is None or number <= room['achievement_hand']:
        return
    if number != room['achievement_hand'] + 1:
        for metric in METRICS:
            reset_metric(room, metric, number)
    for metric, compute in [('wins', lambda h: [main_winner(h)]), ('busts', busted_players)]:
        try:
            recipients = compute(hand)
            if any(pid is not None and pid not in room['players'] for pid in recipients):
                raise ValueError('Missing participant')
        except Exception:
            if not historical:
                raise
            # One incomplete historical metric must not discard the other one.
            logger.warning('Cannot reconstruct %s for room %s hand %s', metric, room['id'], number)
            reset_metric(room, metric, number + 1)
            continue
        for pid in recipients:
            if pid is not None:
                room['players'][pid]['achievements'][metric] += 1
    room['achievement_hand'] = number


def migrate(room):
    if room.get('achievement_version') == VERSION:
        return False
    initialize(room)
    # The latest completed hand also appears in history; count it only once.
    completed = {hand['number']: hand for hand in room['history'] if hand.get('result') is not None}
    current = room.get('hand')
    if current and current.get('result') is not None:
        completed.setdefault(current['number'], current)
    for number in sorted(completed):
        record(room, completed[number], historical=True)
    last_completed = room['number'] - int(bool(current and current.get('result') is None))
    if last_completed > room['achievement_hand']:
        for metric in METRICS:
            reset_metric(room, metric, last_completed + 1)
        room['achievement_hand'] = last_completed
    return True
